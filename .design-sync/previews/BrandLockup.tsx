import { BrandLockup } from 'web';

/** The ATLAS lockup — gradient mark + Space Grotesk wordmark. Three sizes. */
export const Sizes = () => (
  <div style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
    <BrandLockup size="sm" />
    <BrandLockup size="md" />
    <BrandLockup size="lg" />
  </div>
);

/** With the mono caption beneath the wordmark. */
export const WithCaption = () => <BrandLockup size="lg" showCaption />;
