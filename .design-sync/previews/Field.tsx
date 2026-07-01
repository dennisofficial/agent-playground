import { Field } from 'web';

const wrap: React.CSSProperties = { width: 320, display: 'flex', flexDirection: 'column', gap: 16 };

/** Labeled text input — default and filled. */
export const Default = () => (
  <div style={wrap}>
    <Field label="Email" placeholder="you@company.com" />
    <Field label="Organization" defaultValue="Atlas Labs" />
  </div>
);

/** Inline error — red 11.5px message + red border/ring. */
export const WithError = () => (
  <div style={wrap}>
    <Field label="Email" defaultValue="not-an-email" error="Enter a valid email address" />
  </div>
);

/** A label-aside slot — e.g. a "Forgot?" link on the label row. */
export const WithLabelAside = () => (
  <div style={wrap}>
    <Field
      label="Password"
      type="password"
      placeholder="••••••••"
      labelAside={<a style={{ fontSize: 12, color: 'var(--accent)' }} href="#">Forgot?</a>}
    />
  </div>
);
