'use client';

import { inputCls } from '@/components/ui/field';
import { ROUTES } from '@/lib/routes';
import { useCreateOrgMutation } from '@/redux/query/api/org.api';
import { Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Create-organization modal (opened from the sidebar account menu). Names a new org — the caller becomes
 * its owner and it starts in `onboarding`. On success we route to its settings so the operator can set
 * credentials + connect a repo (the onboarding it needs before threads can run).
 */
export function CreateOrgDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [create, createState] = useCreateOrgMutation();
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const valid = trimmed.length >= 2;

  function submit() {
    if (!valid || createState.isLoading) return;
    create({ name: trimmed })
      .unwrap()
      .then((org) => {
        onClose();
        router.push(ROUTES.orgSettings(org.id));
      })
      .catch(() => {
        /* surfaced via createState.isError */
      });
  }

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-70 flex items-start justify-center px-4 pt-30"
      style={{ background: 'rgba(10,12,16,0.5)', backdropFilter: 'blur(3px)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-110 max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: '0 30px 80px rgba(0,0,0,0.4)' }}
        role="dialog"
        aria-modal
      >
        <div className="p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg text-accent"
              style={{
                background: 'var(--accent-soft)',
                border: '1px solid var(--accent-line)',
              }}
            >
              <Building2 size={17} />
            </span>
            <div className="font-disp text-[16px] font-semibold text-text">New organization</div>
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
            Organizations keep separate repos, threads, and credentials. You’ll be its owner — set
            it up next.
          </p>
          <label className="mb-1.5 block text-[11.5px] text-dim">Organization name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="Acme Inc."
            className={inputCls}
            autoFocus
          />
          {createState.isError ? (
            <p className="mt-2.5 text-[11.5px] text-red">
              {(createState.error as Error)?.message ?? 'Could not create the organization.'}
            </p>
          ) : null}
        </div>
        <div
          className="flex items-center justify-end gap-2.5 border-t border-border px-5 py-3.5"
          style={{ background: 'var(--surface-2)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-2 px-3.5 py-2 text-[12.5px] font-medium text-dim transition hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || createState.isLoading}
            onClick={submit}
            className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: 'var(--accent)' }}
          >
            {createState.isLoading ? 'Creating…' : 'Create organization'}
          </button>
        </div>
      </div>
    </div>
  );
}
