'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { inputCls } from '@/components/ui/field';

/**
 * Type-the-slug-to-confirm delete dialog. Deleting an org (with repo/thread/session teardown) has no
 * backend endpoint yet, so confirming surfaces a "not wired" note rather than destroying anything.
 */
export function DeleteOrgDialog({
  orgName,
  slug,
  onClose,
}: {
  orgName: string;
  slug: string;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const armed = text.trim() === slug;

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[120px]"
      style={{ background: 'rgba(10,12,16,0.5)', backdropFilter: 'blur(3px)' }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[440px] max-w-[90%] overflow-hidden rounded-lg border border-border-2 bg-panel"
        style={{ boxShadow: '0 30px 80px rgba(0,0,0,0.4)' }}
        role="dialog"
        aria-modal
      >
        <div className="p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg text-red"
              style={{ background: 'color-mix(in srgb, var(--red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--red) 40%, transparent)' }}
            >
              <Trash2 size={17} />
            </span>
            <div className="font-disp text-[16px] font-semibold text-text">Delete {orgName}?</div>
          </div>
          <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
            This permanently deletes the org, its connected repos, and every thread. Running agent sessions are torn
            down. This cannot be undone.
          </p>
          <p className="mb-1.5 text-[11.5px] text-dim">
            Type <span className="font-mono text-text">{slug}</span> to confirm:
          </p>
          <input
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setAttempted(false);
            }}
            placeholder={slug}
            className={inputCls}
            autoFocus
          />
          {attempted ? (
            <p className="mt-2.5 text-[11.5px] text-red">
              Organization deletion isn’t wired to the backend yet — nothing was deleted.
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
            disabled={!armed}
            onClick={() => setAttempted(true)}
            className="rounded-md px-4 py-2 text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-45"
            style={{ background: 'var(--red)' }}
          >
            Delete organization
          </button>
        </div>
      </div>
    </div>
  );
}
