import type { SessionEngine } from '../domain';

/**
 * A narrow, dependency-inverted seam for persisting a REFRESHED engine subscription credential back to
 * its durable store. Defined in the engine layer (which both the sandbox runner and the onboarding module
 * already depend on) so the sandbox `RedisEngineRunner` can fire it WITHOUT depending on credential
 * semantics — the onboarding module binds the concrete implementation.
 *
 * Fired host-side, best-effort, after a turn whose engine rewrote its `auth.json` (a token refresh). The
 * implementation is responsible for the atomic, monotonic write (never clobber a newer stored blob).
 */
export interface AuthRefreshSink {
  /**
   * Persist a refreshed subscription secret for (orgId, engine). Implementations MUST be safe to call
   * concurrently (atomic + monotonic) and MUST NOT throw into the caller's turn-completion path.
   */
  persist(orgId: string, engine: SessionEngine, secret: string): Promise<void>;
}

/** DI token for {@link AuthRefreshSink} (bound in the @Global onboarding module). */
export const AUTH_REFRESH_SINK = Symbol('AUTH_REFRESH_SINK');
