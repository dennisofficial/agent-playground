import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ClaudeCredentialStore } from './claude-credential.store';
import {
  buildClaudeOAuthConfig,
  ClaudeOAuthHttpError,
  isHardAuthFailure,
  refresh,
  type TokenSet,
} from './claude-oauth.client';

const DEFAULT_REFRESH_SKEW_MS = 30 * 60_000;

/** The selected credential's refresh grant was rejected — the org owner must re-login before turns can run. */
export class CredentialNeedsReauthError extends Error {
  constructor(readonly credentialId: string) {
    super(`claude credential ${credentialId} needs reauth`);
    this.name = 'CredentialNeedsReauthError';
  }
}

/**
 * The single host-side auto-refresh core every caller (per-turn resolution, the proactive sweep, the usage
 * probe) funnels through. Refreshes a `personal` credential's Claude OAuth token when it's within `skewMs`
 * of expiry, using a pessimistic row lock as the cross-instance mutex so concurrent callers never issue a
 * duplicate refresh or race the rotating refresh token.
 */
@Injectable()
export class CredentialRefreshService {
  private readonly logger = new Logger(CredentialRefreshService.name);

  constructor(
    private readonly store: ClaudeCredentialStore,
    private readonly env: EnvService,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Return a usable injectable secret for the credential, refreshing first when a `personal` token is within
   * `skewMs` of expiry. Setup tokens and tokens without a refresh token pass through unchanged.
   */
  async ensureFresh(
    orgId: string,
    credentialId: string,
    skewMs = DEFAULT_REFRESH_SKEW_MS,
  ): Promise<string> {
    const row = await this.store.getDecryptedById(orgId, credentialId);
    if (!row) {
      throw new Error(`credential ${credentialId} not found for org ${orgId}`);
    }
    if (row.kind !== 'personal') return row.secret;
    if (row.status === 'needs_reauth') {
      throw new CredentialNeedsReauthError(credentialId);
    }
    const oauth = parseOauthBlob(row.secret);
    if (!oauth?.refreshToken) return row.secret;
    if (oauth.expiresAt == null || oauth.expiresAt > Date.now() + skewMs) {
      return row.secret;
    }
    return this.refreshLocked(orgId, credentialId, skewMs);
  }

  private async refreshLocked(
    orgId: string,
    credentialId: string,
    skewMs: number,
  ): Promise<string> {
    // A hard auth failure must NOT be written inside the transaction: throwing to abort the refuted refresh
    // would roll the `needs_reauth` write back. Record the status here and commit it after the txn unwinds.
    let hardFailStatus: number | undefined;
    try {
      return await this.dataSource.transaction(async (m) => {
        const held = await this.store.findPersonalUnderLock(m, orgId, credentialId);
        if (!held) {
          throw new Error(`credential ${credentialId} not found under lock`);
        }
        if (held.row.status === 'needs_reauth') {
          throw new CredentialNeedsReauthError(credentialId);
        }
        const cur = parseOauthBlob(held.secret);
        if (cur?.expiresAt != null && cur.expiresAt > Date.now() + skewMs) {
          return held.secret; // another instance refreshed while we blocked on the lock
        }
        if (!cur?.refreshToken) {
          throw new Error(`credential ${credentialId} has no refresh token`);
        }
        try {
          const t = await refresh(buildClaudeOAuthConfig(this.env), {
            refreshToken: cur.refreshToken,
          });
          const secret = toClaudeBlob(t);
          await this.store.writeRefreshedWithinTxn(m, held.row, secret);
          this.logger.log(`refreshed claude credential org=${orgId} id=${credentialId}`);
          return secret;
        } catch (err) {
          if (err instanceof ClaudeOAuthHttpError && isHardAuthFailure(err.status)) {
            hardFailStatus = err.status;
          }
          throw err;
        }
      });
    } catch (err) {
      if (hardFailStatus != null) {
        await this.store.markNeedsReauth(
          orgId,
          credentialId,
          `oauth refresh HTTP ${hardFailStatus}`,
        );
        throw new CredentialNeedsReauthError(credentialId);
      }
      throw err;
    }
  }
}

/** Guarded parse of a `{claudeAiOauth:{…}}` blob; null on malformed input (never throws). */
function parseOauthBlob(
  secret: string,
): { accessToken: string; refreshToken: string; expiresAt?: number } | null {
  try {
    const oauth = (
      JSON.parse(secret) as {
        claudeAiOauth?: {
          accessToken?: unknown;
          refreshToken?: unknown;
          expiresAt?: unknown;
        };
      }
    ).claudeAiOauth;
    if (
      !oauth ||
      typeof oauth.accessToken !== 'string' ||
      typeof oauth.refreshToken !== 'string' ||
      (oauth.expiresAt !== undefined && typeof oauth.expiresAt !== 'number')
    ) {
      return null;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Serialize a refreshed `TokenSet` into the injectable `claudeAiOauth` blob shape. */
function toClaudeBlob(t: TokenSet): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
      scopes: t.scopes ? t.scopes.split(' ') : undefined,
      subscriptionType: t.subscriptionType,
    },
  });
}
