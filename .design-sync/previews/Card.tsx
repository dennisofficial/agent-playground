import { Card } from 'web';

/** A surface panel — hairline border + soft card shadow — holding content. */
export const Default = () => (
  <Card style={{ width: 340, padding: 18 }}>
    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>Add /health endpoint</div>
    <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--dim)', lineHeight: 1.5 }}>
      Expose a version + uptime probe on the API so the orchestrator can verify a green build.
    </div>
  </Card>
);

/** Cards compose — a header row, a divider, and a body. */
export const WithSections = () => (
  <Card style={{ width: 340, overflow: 'hidden' }}>
    <div style={{ padding: '12px 16px', fontFamily: 'var(--f-mono)', fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--dim)' }}>
      cubix-infra
    </div>
    <div style={{ borderTop: '1px solid var(--border)', padding: 16, fontSize: 13, color: 'var(--text)' }}>
      3 threads · 1 awaiting approval
    </div>
  </Card>
);
