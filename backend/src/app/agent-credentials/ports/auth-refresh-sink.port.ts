import type { EAgentProvider } from '@workspace/shared';

/** Identifies which credential a mid-run refresh belongs to. */
export interface AuthRefreshProvenance {
  orgId: string;
  credentialId: string;
  provider: EAgentProvider;
}

/**
 * The write-back seam for when the engine's SDK rotates a token mid-run (Claude refreshes
 * `.credentials.json`, Codex rewrites `auth.json`). The engine calls {@link persist} with the fresh
 * secret; the module persists it only if it's newer than what's stored. Bound to {@link AUTH_REFRESH_SINK}.
 * No callers until the engine milestone — this is the inbound half of the seam, defined now.
 */
export interface AuthRefreshSink {
  persist(provenance: AuthRefreshProvenance, secret: string): Promise<void>;
}

export const AUTH_REFRESH_SINK = Symbol('AUTH_REFRESH_SINK');
