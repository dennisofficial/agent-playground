import { PasswordField } from 'web';

const wrap: React.CSSProperties = { width: 320, display: 'flex', flexDirection: 'column', gap: 16 };

/** Password input with an in-field show/hide toggle (mono, right-aligned). */
export const Default = () => (
  <div style={wrap}>
    <PasswordField label="Password" defaultValue="hunter2!" />
  </div>
);

/** With an inline validation error. */
export const WithError = () => (
  <div style={wrap}>
    <PasswordField label="Password" defaultValue="short" error="At least 8 characters" />
  </div>
);
