import { Button } from 'web';

const row: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' };

/** The four variants — accent-gradient primary, soft, ghost, and danger. */
export const Variants = () => (
  <div style={row}>
    <Button variant="primary">Approve plan</Button>
    <Button variant="soft">Re-plan</Button>
    <Button variant="ghost">Cancel</Button>
    <Button variant="danger">Deny</Button>
  </div>
);

/** Three sizes on the primary variant. */
export const Sizes = () => (
  <div style={row}>
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
  </div>
);

/** Loading swaps to a spinner + verb and disables the control. */
export const Loading = () => (
  <div style={row}>
    <Button loading loadingText="Signing in…">Sign in</Button>
    <Button variant="ghost" loading>Saving</Button>
  </div>
);

/** With a leading icon, and a disabled control. */
export const IconAndDisabled = () => (
  <div style={row}>
    <Button
      icon={
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      }
    >
      New job
    </Button>
    <Button variant="ghost" disabled>Unavailable</Button>
  </div>
);

/** Full-width block button (fills its container). */
export const Block = () => (
  <div style={{ width: 280 }}>
    <Button block>Continue</Button>
  </div>
);
