import { StatusPill } from 'web';

/** A status pill — dot + label, tinted by status. */
export const AllStatuses = () => (
  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
    {(['running', 'planning', 'plan_review', 'awaiting_approval', 'triaging', 'paused', 'failed', 'done'] as const).map((s) => (
      <StatusPill key={s} status={s} />
    ))}
  </div>
);
