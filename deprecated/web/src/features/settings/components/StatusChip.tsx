'use client';
import { Tone } from './credentials-section';

export function StatusChip({ label, tone }: { label: string; tone: Tone }) {
  const color = tone === 'green' ? 'var(--green)' : tone === 'dim' ? 'var(--dim)' : 'var(--faint)';
  const bg = tone === 'green' ? 'var(--green-soft)' : 'var(--surface-2)';
  const border =
    tone === 'green' ? 'color-mix(in srgb, var(--green) 32%, transparent)' : 'var(--border-2)';
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
      style={{ color, background: bg, borderColor: border }}
    >
      {tone === 'green' ? (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--green)' }} />
      ) : null}
      {label}
    </span>
  );
}
