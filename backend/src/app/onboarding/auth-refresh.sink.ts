import { Injectable, Logger } from '@nestjs/common';
import type { SessionEngine } from '../domain';
import type { AuthRefreshSink } from '../engine/auth-refresh.port';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * The concrete {@link AuthRefreshSink}: persist a REFRESHED Codex subscription credential back to the
 * encrypted org store. Bound to the `AUTH_REFRESH_SINK` token so the sandbox `RedisEngineRunner` can fire
 * it at the turn-completion chokepoint without depending on credential internals.
 *
 * Codex-only (Claude drives off an env OAuth token, not a refreshable `auth.json`). The atomic, monotonic
 * write lives in {@link TenantCredentialStore.advanceCodexAuthSecret}; here we only route + guarantee the
 * call NEVER throws into the turn-completion path (a failed persist must not fail the turn).
 */
@Injectable()
export class AuthRefreshSinkService implements AuthRefreshSink {
  private readonly logger = new Logger(AuthRefreshSinkService.name);

  constructor(private readonly store: TenantCredentialStore) {}

  async persist(orgId: string, engine: SessionEngine, secret: string): Promise<void> {
    if (engine !== 'codex') return; // only Codex refreshes a file-based auth.json
    try {
      await this.store.advanceCodexAuthSecret(orgId, secret);
    } catch (err) {
      // Best-effort: a failed write-back leaves the (still-valid this turn) stored blob in place; the next
      // successful turn re-persists. Never propagate — this runs after the turn already produced its result.
      this.logger.warn(
        `codex auth-refresh persist failed for team=${orgId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
