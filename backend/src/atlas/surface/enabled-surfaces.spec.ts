import { describe, expect, it } from 'vitest';
import { isSurfaceEnabled, parseEnabledSurfaces } from './enabled-surfaces';

describe('parseEnabledSurfaces', () => {
  it('defaults to [slack] when nothing is set', () => {
    expect(parseEnabledSurfaces({})).toEqual(['slack']);
  });

  it('parses an ATLAS_SURFACES comma list', () => {
    expect(parseEnabledSurfaces({ surfaces: 'web,slack' })).toEqual(['slack', 'web']);
  });

  it('is order-stable (KNOWN_SURFACES priority), regardless of input order', () => {
    expect(parseEnabledSurfaces({ surfaces: 'agent,web,slack' })).toEqual(['slack', 'web', 'agent']);
  });

  it('trims whitespace, lowercases, and de-dupes', () => {
    expect(parseEnabledSurfaces({ surfaces: ' WEB , web ,SLACK ' })).toEqual(['slack', 'web']);
  });

  it('drops unknown tokens', () => {
    expect(parseEnabledSurfaces({ surfaces: 'web,bogus,sms' })).toEqual(['web']);
  });

  it('falls back to [slack] when the list is all-unknown / blank', () => {
    expect(parseEnabledSurfaces({ surfaces: 'bogus,,  ' })).toEqual(['slack']);
  });

  it('uses ATLAS_SURFACE as a back-compat alias when ATLAS_SURFACES is unset', () => {
    expect(parseEnabledSurfaces({ surface: 'agent' })).toEqual(['agent']);
    expect(parseEnabledSurfaces({ surface: 'web' })).toEqual(['web']);
  });

  it('lets ATLAS_SURFACES win over the legacy ATLAS_SURFACE', () => {
    expect(parseEnabledSurfaces({ surfaces: 'web,slack', surface: 'agent' })).toEqual([
      'slack',
      'web',
    ]);
  });
});

describe('isSurfaceEnabled', () => {
  it('reflects the enabled set', () => {
    expect(isSurfaceEnabled('web', { surfaces: 'web,slack' })).toBe(true);
    expect(isSurfaceEnabled('agent', { surfaces: 'web,slack' })).toBe(false);
    expect(isSurfaceEnabled('slack', {})).toBe(true); // default
    expect(isSurfaceEnabled('web', { surface: 'web' })).toBe(true); // legacy alias
  });
});
