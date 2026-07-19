'use client';

import { inputCls } from '@/components/ui/field';
import { ROUTES } from '@/lib/routes';
import { useDeleteOrgMutation } from '@/redux/query/api/org.api';
import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Type-the-name-to-confirm delete dialog. Confirming hits `DELETE /orgs/:orgId` (owner-only), which
 * tears down the org's repos, threads, and live agent sessions. On success we route to the workspace (the
 * deleted org's settings page no longer resolves).
 */
export function DeleteOrgDialog({
  orgId,
  orgName,
  onClose,
}: {
  orgId: string;
  orgName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [del, delState] = useDeleteOrgMutation();
  const [text, setText] = useState('');
  const armed = text.trim() === orgName;

  function confirmDelete() {
    if (!armed || delState.isLoading) return;
    del(orgId)
      .unwrap()
      .then(() => {
        onClose();
        router.push(ROUTES.workspace());
      })
      .catch(() => {
        /* surfaced via delState.isError */
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
              className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg text-red"
              style={{
                background: 'color-mix(in srgb, var(--red) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--red) 40%, transparent)',
              }}
            >
              <Trash2 size={17} />
            </span>
            <div className="font-disp text-[16px] font-semibold text-text">Delete {orgName}?</div>
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
            This permanently deletes the org, its connected repos, and every thread. Running agent
            sessions are torn down. This cannot be undone.
          </p>
          <p className="mb-1.5 text-[11.5px] text-dim">
            Type <span className="font-mono text-text">{orgName}</span> to confirm:
          </p>
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              delState.reset();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmDelete();
            }}
            placeholder={orgName}
            className={inputCls}
            autoFocus
          />
          {delState.isError ? (
            <p className="mt-2.5 text-[11.5px] text-red">
              {(delState.error as Error)?.message ?? 'Could not delete the organization.'}
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
            disabled={!armed || delState.isLoading}
            onClick={confirmDelete}
            className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: 'var(--red)' }}
          >
            {delState.isLoading ? 'Deleting…' : 'Delete organization'}
          </button>
        </div>
      </div>
    </div>
  );
}
