import {
  EngineAuthError,
  NO_ENGINE_CREDENTIAL_MARKER,
  type EngineAuth,
} from '../engine.types';

/**
 * Resolve the run's subscription secret: the host-resolved per-org secret MUST arrive as `explicit`.
 * There is NO env/config fallback and NO api_key path — a missing secret THROWS so the turn fails
 * loudly instead of silently billing the API or borrowing an ambient credential.
 */
export class EngineAuthResolver {
  resolve(
    engine: 'claude' | 'codex',
    explicit: EngineAuth | undefined,
  ): EngineAuth {
    if (explicit) return explicit;
    // Classify as an auth halt (marker → clean, resumable credentials halt at the driver) rather than a
    // plain Error that fails the job opaquely: a missing credential is fixable by connecting an account.
    throw new EngineAuthError(
      `${NO_ENGINE_CREDENTIAL_MARKER}: no ${engine} subscription secret — the org has no ${engine} ` +
        'credential set (connect one in Settings).',
      undefined,
      engine,
    );
  }
}
