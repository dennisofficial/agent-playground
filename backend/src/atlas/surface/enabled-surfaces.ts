/**
 * The ENABLED-SURFACE resolver — the single source of truth for which `ChatSurface` adapters are live.
 *
 * Atlas can run several chat surfaces at once (e.g. Slack AND web). The set is configured by env:
 *  - `ATLAS_SURFACES` — a comma list ('web,slack'); the authoritative knob.
 *  - `ATLAS_SURFACE`  — the legacy single-surface switch ('slack' | 'agent' | 'web'); a back-compat
 *    alias used only when `ATLAS_SURFACES` is unset.
 *  - neither set → default `['slack']` (byte-identical to the prior single-Slack default).
 *
 * Both the surface module (which builds the `CompositeChatSurface`) and the web-surface controller gate
 * resolve through here, so "is web enabled?" is answered the same way everywhere.
 */

/** The known chat surfaces, in deterministic priority order (also the composite's fallback order). */
export const KNOWN_SURFACES = ['slack', 'web', 'agent'] as const;
export type SurfaceId = (typeof KNOWN_SURFACES)[number];

/** The raw env inputs the resolver reads (passed in so this stays a pure, testable function). */
export interface SurfaceEnvInput {
  /** `ATLAS_SURFACES` — comma list (authoritative). */
  surfaces?: string;
  /** `ATLAS_SURFACE` — legacy single value (back-compat alias). */
  surface?: string;
}

function isKnown(s: string): s is SurfaceId {
  return (KNOWN_SURFACES as readonly string[]).includes(s);
}

/**
 * Resolve the enabled surface set from env. `ATLAS_SURFACES` wins (comma list); else the single
 * `ATLAS_SURFACE`; else `['slack']`. Unknown tokens are dropped; the result is de-duped and returned in
 * `KNOWN_SURFACES` priority order (so the composite's fallback default — the first element — is stable).
 * Never empty: an all-unknown / blank input falls back to `['slack']`.
 */
export function parseEnabledSurfaces(input: SurfaceEnvInput): SurfaceId[] {
  const raw = (input.surfaces ?? input.surface ?? '').trim();
  const requested = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SurfaceId => isKnown(s));
  const set = new Set<SurfaceId>(requested.length ? requested : ['slack']);
  return KNOWN_SURFACES.filter((s) => set.has(s));
}

/** True when `name` is in the enabled set for the given env. */
export function isSurfaceEnabled(name: SurfaceId, input: SurfaceEnvInput): boolean {
  return parseEnabledSurfaces(input).includes(name);
}
