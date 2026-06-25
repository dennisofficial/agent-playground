'use client';

import { useState } from 'react';
import { inputCls } from '@/components/ui/field';
import { orgSwatch, orgInitials, slugify } from '@/lib/org-display';
import type { OrgSummary } from '@/lib/api/me';
import { useUpdateOrg } from '@/lib/api/orgs';
import { DeleteOrgDialog } from './delete-org-dialog';

/**
 * General settings — org identity + status + the danger zone. Rename / re-slug persist via
 * `PATCH /web/orgs/:orgId` and delete via `DELETE /web/orgs/:orgId` (both owner-only); a non-owner sees
 * the write affordances disabled, and the backend enforces it regardless.
 */
export function GeneralSection({ org }: { org: OrgSummary }) {
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [showDelete, setShowDelete] = useState(false);
  const active = org.status === 'active';
  const isOwner = org.role === 'owner';
  const update = useUpdateOrg(org.id);
  const dirty = name.trim() !== org.name || slug !== org.slug;

  function onName(v: string) {
    setName(v);
    setSlug(slugify(v));
    update.reset();
  }

  function save() {
    if (!isOwner || !dirty || update.isPending) return;
    update.mutate({ name: name.trim(), slug });
  }

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">General</h1>
      <p className="mb-7 mt-1.5 text-[13px] text-dim">Your organization’s identity and status.</p>

      <div className="flex items-start gap-[18px]">
        <div className="flex shrink-0 flex-col items-center gap-1.5">
          <span
            className="flex h-16 w-16 items-center justify-center rounded-[15px] font-disp text-[26px] font-semibold text-white"
            style={{ background: orgSwatch() }}
          >
            {orgInitials(name || org.name)}
          </span>
          <span className="cursor-not-allowed rounded-sm border border-border-2 px-2 py-1 font-mono text-[9px] text-dim opacity-70">
            Change
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-dim">Organization name</label>
            <input value={name} onChange={(e) => onName(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-dim">Slug</label>
            <div className="flex items-center overflow-hidden rounded-md border border-border-2 bg-surface-2">
              <span className="py-2.5 pl-3 font-mono text-[12.5px] text-faint">atlas.dev/</span>
              <input
                value={slug}
                onChange={(e) => {
                  setSlug(slugify(e.target.value));
                  update.reset();
                }}
                className="flex-1 bg-transparent py-2.5 pl-px pr-3 font-mono text-[12.5px] font-semibold text-accent outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-[12px] text-dim">Status</span>
            <span
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
              style={{
                color: active ? 'var(--green)' : 'var(--faint)',
                background: active ? 'var(--green-soft)' : 'var(--surface-2)',
                borderColor: active ? 'color-mix(in srgb, var(--green) 32%, transparent)' : 'var(--border-2)',
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: active ? 'var(--green)' : 'var(--faint)' }}
              />
              {active ? 'Active' : org.status}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            <button
              type="button"
              onClick={save}
              disabled={!isOwner || !dirty || update.isPending}
              title={isOwner ? undefined : 'Only the organization owner can rename it'}
              className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
              style={{ background: 'var(--accent)' }}
            >
              {update.isPending ? 'Saving…' : 'Save changes'}
            </button>
            {update.isSuccess && !dirty ? <span className="text-[11.5px] text-green">✓ Saved</span> : null}
            {update.isError ? (
              <span className="text-[11.5px] text-red">
                {(update.error as Error)?.message ?? 'Could not save changes.'}
              </span>
            ) : null}
          </div>
          {!isOwner ? (
            <p className="text-[11px] text-faint">Only the organization owner can change these settings.</p>
          ) : null}
        </div>
      </div>

      {/* Danger zone */}
      <div
        className="mt-10 overflow-hidden rounded-lg border"
        style={{ borderColor: 'color-mix(in srgb, var(--red) 32%, transparent)' }}
      >
        <div
          className="px-[18px] py-3.5 font-mono text-[9px] tracking-[0.14em] text-red"
          style={{ background: 'color-mix(in srgb, var(--red) 8%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--red) 22%, transparent)' }}
        >
          DANGER ZONE
        </div>
        <DangerRow
          title="Leave organization"
          body="Remove yourself. Ownership must transfer first."
          action={
            <button
              type="button"
              disabled
              title="Leaving isn’t wired yet"
              className="cursor-not-allowed rounded-md border border-border-2 px-3.5 py-2 text-[12px] font-medium text-dim opacity-70"
            >
              Leave
            </button>
          }
          divider
        />
        <DangerRow
          title="Delete organization"
          body={`Permanently delete ${org.name}, its repos and threads.`}
          action={
            <button
              type="button"
              onClick={() => setShowDelete(true)}
              disabled={!isOwner}
              title={isOwner ? undefined : 'Only the organization owner can delete it'}
              className="rounded-md px-3.5 py-2 text-[12px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
              style={{ background: 'var(--red)' }}
            >
              Delete
            </button>
          }
        />
      </div>

      {showDelete ? (
        <DeleteOrgDialog
          orgId={org.id}
          orgName={org.name}
          slug={org.slug}
          onClose={() => setShowDelete(false)}
        />
      ) : null}
    </>
  );
}

function DangerRow({
  title,
  body,
  action,
  divider = false,
}: {
  title: string;
  body: string;
  action: React.ReactNode;
  divider?: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3.5 px-[18px] py-3.5"
      style={divider ? { borderBottom: '1px solid var(--hair)' } : undefined}
    >
      <div className="flex-1">
        <div className="text-[13px] font-semibold text-text">{title}</div>
        <div className="mt-0.5 text-[11.5px] text-dim">{body}</div>
      </div>
      {action}
    </div>
  );
}
