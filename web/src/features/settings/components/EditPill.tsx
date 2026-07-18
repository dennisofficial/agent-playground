'use client';
import { Spinner } from '@/components/ui/spinner';
import { Status } from './credentials-section';

export function EditPill({ status }: { status: Status }) {
  const meta =
    status === 'testing'
      ? {
          text: 'testing…',
          color: 'var(--accent)',
          bg: 'var(--accent-soft)',
          border: 'var(--accent-line)',
        }
      : status === 'valid'
        ? {
            text: 'valid',
            color: 'var(--green)',
            bg: 'var(--green-soft)',
            border: 'color-mix(in srgb, var(--green) 35%, transparent)',
          }
        : status === 'invalid'
          ? {
              text: 'invalid',
              color: 'var(--red)',
              bg: 'color-mix(in srgb, var(--red) 8%, transparent)',
              border: 'color-mix(in srgb, var(--red) 40%, transparent)',
            }
          : {
              text: 'not tested',
              color: 'var(--faint)',
              bg: 'var(--surface-2)',
              border: 'var(--border)',
            };
  return (
    <span
      className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-mono text-[9px]"
      style={{
        color: meta.color,
        background: meta.bg,
        border: `1px solid ${meta.border}`,
      }}
    >
      {status === 'testing' ? <Spinner className="h-2.5 w-2.5" /> : null}
      {meta.text}
    </span>
  );
}
