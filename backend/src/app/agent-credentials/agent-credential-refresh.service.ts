import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '@workspace/shared';
import { SecretCipherService } from '../../_lib/crypto/secret-cipher.service';
import { AgentCredential, AgentCredentialRepo } from './entities/agent-credential.entity';
import {
  type ClaudeCredentialBlob,
  refresh as claudeRefresh,
  tokenSetToBlob,
} from './oauth/claude-oauth.client';
import { decodeJwtExpMs } from './oauth/codex-id-token';
import {
  buildAuthJson,
  refresh as codexRefresh,
  type CodexTokens,
} from './oauth/codex-oauth.client';

const DEFAULT_SKEW_MS = 30 * 60 * 1000;

/** Thrown when a refresh hard-fails (400/401/403) — the account must be re-authorized in the UI. */
export class CredentialNeedsReauthError extends Error {
  constructor(readonly credentialId: string) {
    super(`agent credential ${credentialId} needs re-authorization`);
    this.name = 'CredentialNeedsReauthError';
  }
}

function hardAuthFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 400 || status === 401 || status === 403;
}

@Injectable()
export class AgentCredentialRefreshService {
  private readonly logger = new Logger(AgentCredentialRefreshService.name);

  constructor(
    private readonly repo: AgentCredentialRepo,
    private readonly cipher: SecretCipherService,
  ) {}

  /** Return fresh runtime material for a credential, refreshing first if near expiry. */
  async ensureFresh(
    orgId: string,
    credentialId: string,
    skewMs = DEFAULT_SKEW_MS,
  ): Promise<string> {
    const row = await this.repo.findOne({ where: { id: credentialId, orgId } });
    if (!row) throw new NotFoundException('Agent credential not found');
    const material = this.cipher.decrypt(row.materialEnc);
    if (row.kind === EAgentCredentialKind.SETUP_TOKEN) return material; // no refresh
    if (!this.needsRefresh(row.expiresAt, skewMs)) return material;
    return this.refreshLocked(credentialId, skewMs);
  }

  private needsRefresh(expiresAt: Date | null, skewMs: number): boolean {
    return !!expiresAt && expiresAt.getTime() - Date.now() <= skewMs;
  }

  private async refreshLocked(credentialId: string, skewMs: number): Promise<string> {
    return this.repo.manager.transaction(async (m) => {
      const row = await m.findOne(AgentCredential, {
        where: { id: credentialId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('Agent credential not found');
      const current = this.cipher.decrypt(row.materialEnc);
      // Re-check under the lock — a concurrent refresh may have already renewed it.
      if (!this.needsRefresh(row.expiresAt, skewMs)) return current;
      try {
        const { material, expiresAt } =
          row.provider === EAgentProvider.CLAUDE
            ? await this.refreshClaude(current)
            : await this.refreshCodex(current);
        row.materialEnc = this.cipher.encrypt(material);
        row.expiresAt = expiresAt;
        row.lastRefreshedAt = new Date();
        row.status = EAgentCredentialStatus.ACTIVE;
        await m.save(row);
        return material;
      } catch (err) {
        if (hardAuthFailure(err) || err instanceof MissingRefreshTokenError) {
          row.status = EAgentCredentialStatus.NEEDS_REAUTH;
          await m.save(row);
          throw new CredentialNeedsReauthError(credentialId);
        }
        this.logger.warn(`refresh failed for ${credentialId}: ${String(err)}`);
        throw err;
      }
    });
  }

  private async refreshClaude(current: string): Promise<{ material: string; expiresAt: Date }> {
    const blob = JSON.parse(current) as ClaudeCredentialBlob;
    const refreshToken = blob.claudeAiOauth?.refreshToken;
    if (!refreshToken) throw new MissingRefreshTokenError();
    const tokenSet = await claudeRefresh(refreshToken);
    return {
      material: JSON.stringify(tokenSetToBlob(tokenSet)),
      expiresAt: new Date(tokenSet.expiresAt),
    };
  }

  private async refreshCodex(
    current: string,
  ): Promise<{ material: string; expiresAt: Date | null }> {
    const auth = JSON.parse(current) as {
      tokens?: Partial<CodexTokens & { refresh_token: string }>;
    };
    const tokens = auth.tokens;
    const refreshToken = tokens?.refresh_token;
    if (!refreshToken || !tokens) throw new MissingRefreshTokenError();
    const next = await codexRefresh(refreshToken);
    const merged: CodexTokens = {
      idToken: next.idToken ?? (tokens as { id_token?: string }).id_token ?? '',
      accessToken: next.accessToken ?? (tokens as { access_token?: string }).access_token ?? '',
      refreshToken: next.refreshToken ?? refreshToken,
    };
    const expMs = decodeJwtExpMs(merged.accessToken);
    return {
      material: buildAuthJson(merged, new Date().toISOString()),
      expiresAt: expMs ? new Date(expMs) : null,
    };
  }
}

class MissingRefreshTokenError extends Error {}
