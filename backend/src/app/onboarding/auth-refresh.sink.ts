import { Injectable, Logger } from '@nestjs/common';
import type { SessionEngine } from '@shared/domain';
import type { AuthRefreshSink } from '@shared/engine/auth-refresh.port';
import { ClaudeCredentialStore } from './claude-credential.store';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * The concrete {@link AuthRefreshSink}: persist a REFRESHED engine subscription credential back to the
 * encrypted org store. Bound to the `AUTH_REFRESH_SINK` token so the sandbox `RedisEngineRunner` can fire
 * it at the turn-completion chokepoint without depending on credential internals.
 *
 * Branches by engine: Codex's `auth.json` refresh routes through
 * {@link TenantCredentialStore.advanceCodexAuthSecret}; Claude's `.credentials.json` self-refresh (for a
 * `personal` credential) routes through {@link ClaudeCredentialStore.advanceClaudeCredential}, keyed by
 * `credentialId`. Both stores own the atomic, monotonic write; here we only route + guarantee the call
 * NEVER throws into the turn-completion path (a failed persist must not fail the turn).
 */
@Injectable()
export class AuthRefreshSinkService implements AuthRefreshSink {
  private readonly logger = new Logger(AuthRefreshSinkService.name);

  constructor(
    private readonly tenantStore: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
  ) {}

  async persist(
    provenance: { orgId: string; engine: SessionEngine; credentialId?: string },
    secret: string,
  ): Promise<void> {
    const { orgId, engine, credentialId } = provenance;
    try {
      if (engine === 'codex') await this.tenantStore.advanceCodexAuthSecret(orgId, secret);
      else if (engine === 'claude')
        await this.claudeStore.advanceClaudeCredential(orgId, credentialId, secret);
    } catch (err) {
      // Best-effort: a failed write-back leaves the (still-valid this turn) stored blob in place; the next
      // successful turn re-persists. Never propagate — this runs after the turn already produced its result.
      this.logger.warn(
        `${engine} auth-refresh persist failed for team=${orgId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
