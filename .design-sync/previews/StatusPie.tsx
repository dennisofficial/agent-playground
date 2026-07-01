import { StatusPie } from 'web';

const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', fontSize: 10, color: 'var(--dim)', fontFamily: 'var(--f-mono)' };

/** A 14px glyph whose SHAPE encodes the stage and COLOR names the status. */
export const AllStatuses = () => (
  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
    {(['planning', 'triaging', 'plan_review', 'running', 'awaiting_approval', 'paused', 'failed', 'done'] as const).map((s) => (
      <span key={s} style={cell}>
        <StatusPie status={s} size={22} />
        {s}
      </span>
    ))}
  </div>
);

/** Undefined status → a neutral hollow ring (cross-org inbox rows carry no status). */
export const Neutral = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    <StatusPie size={22} />
    <span style={{ fontSize: 12, color: 'var(--dim)' }}>no status</span>
  </div>
);
