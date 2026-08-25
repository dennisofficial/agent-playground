'use client';
import type { JobMessage } from '@/lib/api/job-api';
import { useState } from 'react';
import { Markdown } from '../markdown';
import { reminderLabel } from './bubbles';

export function SystemReminderChip({ message }: { message: JobMessage }) {
  const [open, setOpen] = useState(false);
  const label = reminderLabel(message.meta?.reminderKind as string | undefined);
  const fullBody = (message.meta?.fullBody as string | undefined) ?? message.text;
  return (
    <div className="anim-fadeUp flex flex-col items-end gap-1 self-stretch">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-dim"
        style={{
          borderColor: 'var(--hair)',
          background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
        }}
      >
        <span className="h-1 w-1 rounded-full" style={{ background: 'var(--dim)' }} />
        harness · {label}
      </button>
      {open ? (
        <div
          className="max-w-[92%] rounded-md border px-3 py-2 text-[12px] text-dim"
          style={{
            borderColor: 'var(--hair)',
            background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
          }}
        >
          <Markdown>{fullBody}</Markdown>
        </div>
      ) : null}
    </div>
  );
}
