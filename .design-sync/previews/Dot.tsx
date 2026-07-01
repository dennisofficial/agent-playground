import { Dot } from 'web';

const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', fontSize: 10, color: 'var(--dim)', fontFamily: 'var(--f-mono)' };

/** A plain colored dot — used for section nodes and system-event tones. */
export const Tones = () => (
  <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
    {([['accent', '--accent'], ['green', '--green'], ['blue', '--blue'], ['slate', '--slate'], ['faint', '--faint']] as const).map(([label, v]) => (
      <span key={label} style={cell}>
        <Dot color={`var(${v})`} size={9} />
        {label}
      </span>
    ))}
  </div>
);

/** Pulsing — for a live / active node. */
export const Pulsing = () => (
  <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
    <Dot color="var(--accent)" pulse size={10} />
    <Dot color="var(--green)" pulse size={10} />
  </div>
);
