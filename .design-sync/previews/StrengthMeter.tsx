import { StrengthMeter } from 'web';

const cell: React.CSSProperties = { width: 300, display: 'flex', flexDirection: 'column', gap: 6 };
const label: React.CSSProperties = { fontSize: 11, color: 'var(--dim)', fontFamily: 'var(--f-mono)' };

/** 4-segment password strength meter — score 0–4 → width + label + color. */
export const Scale = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div style={cell}>
      <span style={label}>weak</span>
      <StrengthMeter password="abcdef" />
    </div>
    <div style={cell}>
      <span style={label}>fair</span>
      <StrengthMeter password="abcdEFGH" />
    </div>
    <div style={cell}>
      <span style={label}>good</span>
      <StrengthMeter password="abcdEF12" />
    </div>
    <div style={cell}>
      <span style={label}>strong</span>
      <StrengthMeter password="abcdEF12!@" />
    </div>
  </div>
);
