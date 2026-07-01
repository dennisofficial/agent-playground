import { GoogleG, Button } from 'web';

/** The 4-color Google "G" mark at a few sizes. */
export const Sizes = () => (
  <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
    <GoogleG size={16} />
    <GoogleG size={22} />
    <GoogleG size={32} />
  </div>
);

/** Its canonical use — the leading icon on a "Continue with Google" button. */
export const InButton = () => (
  <Button variant="ghost" icon={<GoogleG size={16} />}>
    Continue with Google
  </Button>
);
