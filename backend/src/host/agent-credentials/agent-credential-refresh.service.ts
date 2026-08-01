import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '@workspace/shared';
import { ClaudeOAuthClient, type ClaudeCredentialBlob } from './oauth/claude-oauth.client';
import { CodexAuthService } from './oauth/codex-auth.service';
import { CodexOAuthClient, type CodexTokens } from './oauth/codex-oauth.client';

const DEFAULT_SKEW_MS = 30 * 60 * 1000;

export class CredentialNeedsReauthError extends Error {
  constructor(readonly credentialId: string) {
    super(`agent credential ${credentialId} needs re-authorization`);
    this.name = 'CredentialNeedsReauthError';
  }
}

/**
 * Runs from both a request (usage polling) and the turn-dispatch queue worker (resolving env for a
 * turn) and the keepalive cron — no request is guaranteed in flight, so this injects `PrismaService`.
 */
@Injectable()
export class AgentCredentialRefreshService {
  private readonly logger = new Logger(AgentCredentialRefreshService.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly cipher: SecretCipherService,
    private readonly claudeOAuth: ClaudeOAuthClient,
    private readonly codexOAuth: CodexOAuthClient,
    private readonly codexAuthService: CodexAuthService,
  ) {}

  /** Return fresh runtime material for a credential, refreshing first if near expiry. */
  async ensureFresh(
    orgId: string,
    credentialId: string,
    skewMs = DEFAULT_SKEW_MS,
  ): Promise<string> {
    const row = await this.prismaService.agentCredential.findFirst({
      where: { id: credentialId, orgId },
    });
    if (!row) throw new NotFoundException('Agent credential not found');
    const material = this.cipher.decrypt(row.materialEnc);
    if ((row.kind as EAgentCredentialKind) === EAgentCredentialKind.SETUP_TOKEN) return material; // no refresh
    if (!this.needsRefresh(row.expiresAt, skewMs)) return material;
    return this.refreshLocked(credentialId, skewMs);
  }

  private needsRefresh(expiresAt: Date | null, skewMs: number): boolean {
    return !!expiresAt && expiresAt.getTime() - Date.now() <= skewMs;
  }

  private async refreshLocked(credentialId: string, skewMs: number): Promise<string> {
    return this.prismaService.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_credentials WHERE id = ${credentialId}::uuid FOR UPDATE`;
      const row = await tx.agentCredential.findUnique({ where: { id: credentialId } });
      if (!row) throw new NotFoundException('Agent credential not found');
      const current = this.cipher.decrypt(row.materialEnc);
      // Re-check under the lock — a concurrent refresh may have already renewed it.
      if (!this.needsRefresh(row.expiresAt, skewMs)) return current;
      try {
        const { material, expiresAt } =
          (row.provider as EAgentProvider) === EAgentProvider.CLAUDE
            ? await this.refreshClaude(current)
            : await this.refreshCodex(current);
        await tx.agentCredential.update({
          where: { id: credentialId },
          data: {
            materialEnc: this.cipher.encrypt(material),
            expiresAt,
            lastRefreshedAt: new Date(),
            status: EAgentCredentialStatus.ACTIVE,
          },
        });
        return material;
      } catch (err) {
        if (
          AgentCredentialRefreshService.hardAuthFailure(err) ||
          err instanceof MissingRefreshTokenError
        ) {
          await tx.agentCredential.update({
            where: { id: credentialId },
            data: { status: EAgentCredentialStatus.NEEDS_REAUTH },
          });
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
    const tokenSet = await this.claudeOAuth.refresh(refreshToken);
    return {
      material: JSON.stringify(this.claudeOAuth.tokenSetToBlob(tokenSet)),
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
    const next = await this.codexOAuth.refresh(refreshToken);
    const merged: CodexTokens = {
      idToken: next.idToken ?? (tokens as { id_token?: string }).id_token ?? '',
      accessToken: next.accessToken ?? (tokens as { access_token?: string }).access_token ?? '',
      refreshToken: next.refreshToken ?? refreshToken,
    };
    const expMs = this.codexAuthService.decodeJwtExpMs(merged.accessToken);
    return {
      material: this.codexOAuth.buildAuthJson(merged, new Date().toISOString()),
      expiresAt: expMs ? new Date(expMs) : null,
    };
  }

  private static hardAuthFailure(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    return status === 400 || status === 401 || status === 403;
  }
}

class MissingRefreshTokenError extends Error {}
