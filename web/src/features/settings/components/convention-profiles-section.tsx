'use client';

import { Button } from '@/components/ui/button';
import { inputCls } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { useOrgRepos } from '@/lib/api/job-queries';
import {
  useAttachConventionProfile,
  useConventionProfiles,
  useDeleteConventionProfile,
  useRepoConventionProfile,
  useSaveConventionProfile,
  type ConventionProfile,
} from '@/lib/api/orgs';
import { cn } from '@/lib/cn';
import { AlertCircle, Layers, Lock, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

/**
 * Convention profiles — reusable "house-style" bundles (folder structure, stack idioms, a shared-contract
 * layout) an org defines ONCE and attaches per repo. When a repo opts in, the profile's body is injected
 * into every build-facing prompt for that repo; a repo with none attached builds exactly as before, so a
 * profile can never misfire on a repo that doesn't follow the style. The onboarding agent can also
 * auto-detect a matching profile and propose it (owner-approved); this screen is the manual counterpart.
 * Owner-only writes (the server enforces it).
 */
export function ConventionProfilesSection({ orgId, role }: { orgId: string; role: string }) {
  const { data, isLoading, isError, refetch } = useConventionProfiles(orgId);
  const isOwner = role === 'owner';
  const [editing, setEditing] = useState<ConventionProfile | 'new' | null>(null);

  const profiles = data?.profiles ?? [];

  return (
    <>
      <h1 className="font-disp text-[22px] font-semibold tracking-[-0.01em] text-text">
        Convention Profiles
      </h1>
      <p className="mb-4 mt-1.5 max-w-160 text-[13px] leading-relaxed text-dim">
        Reusable <b className="font-semibold text-text">house-style</b> bundles — folder structure,
        stack idioms, a shared-contract layout. Define one once, then attach it to any repo that
        follows that style. A repo with <b className="font-semibold text-text">none</b> attached
        builds exactly as before, so a profile never misfires on a repo it doesn’t fit.
      </p>

      {!isOwner ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-[11.5px] text-faint">
          <Lock size={13} />
          Read-only — only owners can create, edit, delete, or attach profiles.
        </div>
      ) : null}

      {isLoading ? (
        <div className="mt-7 flex items-center gap-2 text-[12px] text-faint">
          <Spinner className="h-3 w-3" /> Loading convention profiles…
        </div>
      ) : isError || !data ? (
        <div className="mt-7 flex items-start gap-3 rounded-lg border border-red-line bg-red-soft p-5">
          <AlertCircle size={17} className="mt-0.5 shrink-0 text-red" />
          <div className="flex-1">
            <div className="text-[13.5px] font-semibold text-red">
              Couldn’t load convention profiles.
            </div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-dim">
              The server didn’t respond. Check your connection and try again.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="shrink-0 rounded-md border border-border-2 bg-surface px-3.5 py-2 text-[12px] font-semibold text-text transition hover:bg-surface-2"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-faint">
              {profiles.length} profile{profiles.length === 1 ? '' : 's'}
            </div>
            {isOwner ? (
              <Button
                size="sm"
                variant="soft"
                icon={<Plus size={14} />}
                onClick={() => setEditing('new')}
              >
                New profile
              </Button>
            ) : null}
          </div>

          {profiles.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface-2 px-6 py-10 text-center">
              <Layers size={20} className="text-faint" />
              <div className="text-[13px] font-semibold text-text">No convention profiles yet</div>
              <div className="max-w-105 text-[12px] leading-relaxed text-dim">
                Create one (e.g. “NestJS + Next.js + shared contract”) to encode how new code should
                be structured, then attach it to matching repos below.
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {profiles.map((p) => (
                <ProfileCard
                  key={p.slug}
                  orgId={orgId}
                  profile={p}
                  canManage={isOwner}
                  onEdit={() => setEditing(p)}
                />
              ))}
            </div>
          )}

          <div className="h-8.5" />

          <RepoAttachments orgId={orgId} profiles={profiles} canManage={isOwner} />
        </>
      )}

      {editing ? (
        <ProfileEditor
          orgId={orgId}
          existing={editing === 'new' ? null : editing}
          takenSlugs={profiles.map((p) => p.slug)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function ProfileCard({
  orgId,
  profile,
  canManage,
  onEdit,
}: {
  orgId: string;
  profile: ConventionProfile;
  canManage: boolean;
  onEdit: () => void;
}) {
  const del = useDeleteConventionProfile(orgId);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-text">{profile.name}</span>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-dim">
              {profile.slug}
            </code>
          </div>
          {profile.detectHint ? (
            <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-faint">
              Matches: {profile.detectHint}
            </div>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={onEdit}>
              Edit
            </Button>
            {confirming ? (
              <Button
                size="sm"
                variant="danger"
                loading={del.isPending}
                loadingText="Deleting…"
                onClick={() => del.mutate(profile.slug)}
              >
                Confirm delete
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 size={13} />}
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <pre className="mt-3 max-h-35 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 text-[11.5px] leading-relaxed text-dim">
        {profile.body}
      </pre>
    </div>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function ProfileEditor({
  orgId,
  existing,
  takenSlugs,
  onClose,
}: {
  orgId: string;
  existing: ConventionProfile | null;
  takenSlugs: string[];
  onClose: () => void;
}) {
  const save = useSaveConventionProfile(orgId);
  const [name, setName] = useState(existing?.name ?? '');
  const [slug, setSlug] = useState(existing?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(existing));
  const [body, setBody] = useState(existing?.body ?? '');
  const [detectHint, setDetectHint] = useState(existing?.detectHint ?? '');

  const effectiveSlug = existing ? existing.slug : slugTouched ? slug : slugify(name);
  const slugValid = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(effectiveSlug);
  const collision =
    !existing && takenSlugs.includes(effectiveSlug)
      ? 'A profile with this slug already exists.'
      : null;
  const canSave =
    name.trim().length > 0 && body.trim().length > 0 && slugValid && !collision && !save.isPending;

  const submit = () => {
    if (!canSave) return;
    save.mutate(
      {
        slug: effectiveSlug,
        body: {
          name: name.trim(),
          body,
          detectHint: detectHint.trim() || undefined,
        },
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[88vh] w-full max-w-155 flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="text-[14px] font-semibold text-text">
            {existing ? `Edit “${existing.name}”` : 'New convention profile'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-faint transition hover:bg-surface-2 hover:text-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          <label className="mb-1 block text-[12px] font-semibold text-dim">Name</label>
          <input
            className={inputCls}
            value={name}
            placeholder="NestJS + Next.js + shared contract"
            onChange={(e) => setName(e.target.value)}
          />

          <label className="mb-1 mt-4 block text-[12px] font-semibold text-dim">
            Slug {existing ? <span className="text-faint">(fixed)</span> : null}
          </label>
          <input
            className={cn(inputCls, 'font-mono text-[12px]')}
            value={effectiveSlug}
            disabled={Boolean(existing)}
            placeholder="nestjs-next-shared"
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            data-err={(!slugValid || Boolean(collision)) && effectiveSlug.length > 0}
          />
          {effectiveSlug.length > 0 && !slugValid ? (
            <div className="mt-1 text-[11.5px] text-red">
              Lowercase letters, digits, - and _ only.
            </div>
          ) : collision ? (
            <div className="mt-1 text-[11.5px] text-red">{collision}</div>
          ) : null}

          <label className="mb-1 mt-4 block text-[12px] font-semibold text-dim">
            House style (markdown)
          </label>
          <textarea
            className={cn(inputCls, 'h-55 resize-y py-2.5 font-mono text-[12px] leading-relaxed')}
            value={body}
            placeholder={
              '# House style\n\n## Backend (NestJS)\n- one feature = one module; thin controllers…\n\n## Frontend (Next.js)\n- apps/ views, feature folders, atomic components/, libs/…\n\n## Shared contract\n- shared/ holds DTOs + types imported by both ends.'
            }
            onChange={(e) => setBody(e.target.value)}
          />

          <label className="mb-1 mt-4 block text-[12px] font-semibold text-dim">
            Detect hint <span className="text-faint">(optional)</span>
          </label>
          <p className="mb-1.5 text-[11px] leading-relaxed text-faint">
            What stack this matches — the onboarding agent reads this to auto-propose the profile on
            a matching repo.
          </p>
          <textarea
            className={cn(inputCls, 'h-20 resize-y py-2.5 text-[12px] leading-relaxed')}
            value={detectHint}
            placeholder="A NestJS backend + Next.js frontend wired through a shared/ contract dir."
            onChange={(e) => setDetectHint(e.target.value)}
          />

          {save.isError ? (
            <div className="mt-3 rounded-md border border-red-line bg-red-soft px-3 py-2 text-[11.5px] text-red">
              {(save.error as Error).message}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={submit}
          >
            {existing ? 'Save changes' : 'Create profile'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RepoAttachments({
  orgId,
  profiles,
  canManage,
}: {
  orgId: string;
  profiles: ConventionProfile[];
  canManage: boolean;
}) {
  const { data: repos } = useOrgRepos(orgId);

  return (
    <div>
      <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-faint">
        Repo attachments
      </div>
      <p className="mb-3 max-w-140 text-[12px] leading-relaxed text-dim">
        Attach a profile to a repo to build its code in that house style. Leave a repo on{' '}
        <b className="font-semibold text-text">None</b> to keep it convention-free.
      </p>
      {!repos || repos.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-surface-2 px-4 py-6 text-center text-[12px] text-faint">
          No repos connected yet.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
          {repos.map((r) => (
            <RepoAttachmentRow
              key={r.id}
              orgId={orgId}
              repoId={r.id}
              repoName={r.name}
              repoSlug={r.slug}
              profiles={profiles}
              canManage={canManage}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoAttachmentRow({
  orgId,
  repoId,
  repoName,
  repoSlug,
  profiles,
  canManage,
}: {
  orgId: string;
  repoId: string;
  repoName: string;
  repoSlug: string;
  profiles: ConventionProfile[];
  canManage: boolean;
}) {
  const { data, isLoading } = useRepoConventionProfile(orgId, repoId);
  const attach = useAttachConventionProfile(orgId);
  const current = data?.slug ?? '';

  return (
    <div className="flex items-center justify-between gap-3 bg-surface px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-text">{repoName}</div>
        <div className="truncate text-[11px] text-faint">{repoSlug}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {attach.isPending ? <Spinner className="h-3 w-3" /> : null}
        <select
          className={cn(inputCls, 'h-9 w-55 cursor-pointer text-[12px]')}
          value={current}
          disabled={!canManage || isLoading || attach.isPending}
          onChange={(e) =>
            attach.mutate({
              repoId,
              slug: e.target.value === '' ? null : e.target.value,
            })
          }
        >
          <option value="">None (convention-free)</option>
          {profiles.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
