'use client';

import { composerStore, useOutbox } from '@/lib/api/composer-store';
import type { JobRef } from '@/lib/api/job-api';
import { Clock, Image as ImageIcon, X } from 'lucide-react';

/**
 * The offline-send queue tray above the composer ("Composer Resilience" mockup, Section B) — one chip per
 * message the operator sent while disconnected. Toned `--red` (an outage, not the accent's queued-comment
 * tone in `CommentTray`) so it reads as waiting-on-reconnect rather than a normal pending action. Cleared
 * automatically by the `<OutboxFlusher>` as each item actually sends; the remove X lets the operator drop
 * one it no longer wants sent.
 */
export function QueuedTray({ jobRef }: { jobRef: JobRef }) {
  const outbox = useOutbox(jobRef);
  if (outbox.length === 0) return null;

  return (
    <div
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-surface"
      style={{ boxShadow: '0 1px 2px rgba(20,18,12,.05)' }}
    >
      <div className="flex items-center gap-2 px-3 py-[9px] pl-[13px]">
        <span
          className="grid h-[19px] w-[19px] flex-none place-items-center rounded-[5px]"
          style={{
            background: 'color-mix(in srgb, var(--red) 11%, transparent)',
            color: 'var(--red)',
          }}
        >
          <Clock size={11} strokeWidth={2.2} />
        </span>
        <span className="text-[12px] font-semibold text-text">{outbox.length} queued</span>
        <span className="text-[11px] italic text-faint">will send automatically on reconnect</span>
      </div>
      {outbox.map((msg) => {
        const preview =
          msg.text ||
          msg.comments[0]?.quote ||
          (msg.hasAttachments ? 'Attachment' : '') ||
          'Queued message';
        return (
          <div
            key={msg.id}
            className="flex items-start gap-2.5 border-t border-hair px-[11px] py-2 pl-[13px] first:border-t-0"
          >
            <span
              className="w-0.5 flex-none self-stretch rounded-full"
              style={{ background: 'var(--red-line)' }}
            />
            {msg.hasAttachments ? (
              // The bytes live on the server draft (uploaded on-add), not in the outbox — no local preview
              // URL to render, so show a generic file-icon thumb the same size as the old image thumbnail.
              <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[7px] border border-border bg-surface-2 text-dim">
                <ImageIcon size={15} strokeWidth={2} />
              </span>
            ) : (
              <span
                className="mt-px grid h-[22px] w-[22px] flex-none place-items-center rounded-full"
                style={{
                  background: 'color-mix(in srgb, var(--red) 9%, transparent)',
                  color: 'var(--red)',
                }}
              >
                <Clock size={12} strokeWidth={2.2} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] leading-snug text-text">{preview}</div>
              <div
                className="mt-[3px] flex items-center gap-[5px] font-mono text-[10.5px]"
                style={{ color: 'var(--red)' }}
              >
                <span className="inline-block h-2 w-2 animate-spin rounded-full border-[1.4px] border-current border-t-transparent" />
                Queued — waiting to reconnect
              </div>
            </div>
            <button
              type="button"
              onClick={() => composerStore.removeQueued(jobRef.jobId, msg.id)}
              title="Remove from queue"
              className="mt-px grid h-5 w-5 flex-none place-items-center rounded-md text-faint opacity-50"
            >
              <X size={11} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
