import { Spinner } from 'web';

const row: React.CSSProperties = { display: 'flex', gap: 20, alignItems: 'center' };

/** Inline spinner — a rotating ring; color inherits via currentColor. */
export const Sizes = () => (
  <div style={{ ...row, color: 'var(--dim)' }}>
    <Spinner className="h-3.5 w-3.5" />
    <Spinner className="h-4 w-4" />
    <Spinner className="h-6 w-6" />
  </div>
);

/** Inherits the accent color from its parent. */
export const Accent = () => (
  <div style={{ ...row, color: 'var(--accent)' }}>
    <Spinner className="h-5 w-5" />
    <span style={{ fontSize: 13, color: 'var(--dim)' }}>Building…</span>
  </div>
);
