import { StatusDot } from 'web';

const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', fontSize: 10, color: 'var(--dim)', fontFamily: 'var(--f-mono)' };

/** A status dot, colored by status; running/triaging pulse with a soft glow. */
export const AllStatuses = () => (
  <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
    {(['running', 'planning', 'plan_review', 'awaiting_approval', 'triaging', 'paused', 'failed', 'done'] as const).map((s) => (
      <span key={s} style={cell}>
        <StatusDot status={s} size={10} />
        {s}
      </span>
    ))}
  </div>
);
