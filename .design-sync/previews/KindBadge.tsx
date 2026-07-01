import { KindBadge } from 'web';

/** The FEAT / FIX / EVENT mono badge — deliberately neutral grey, hairline border. */
export const Kinds = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <KindBadge kind="feat" />
    <KindBadge kind="fix" />
    <KindBadge kind="event" />
  </div>
);

/** In context — a badge leading a job title. */
export const InContext = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
    <KindBadge kind="feat" />
    Add rolling-deploy leader election
  </div>
);
