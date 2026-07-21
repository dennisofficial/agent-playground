import { Injectable } from '@nestjs/common';
import { EAgentProvider } from '@workspace/shared';
import { AgentCredentialService } from './agent-credential.service';
import { decodeJwtExpMs } from './oauth/codex-id-token.util';
import { parseClaudeExpiresAt } from './oauth/material-freshness.util';

export interface AuthRefreshProvenance {
  orgId: string;
  credentialId: string;
  provider: EAgentProvider;
}

/**
 * Persists a token the engine's SDK rotated mid-run. Derives the new expiry from the secret itself and hands
 * it to the store, which writes it only if it's newer than what's held — so a slow write-back never clobbers
 * a fresher token. Exported directly (no port); the engine calls it across the app↔engine boundary later.
 */
@Injectable()
export class AgentAuthRefreshSink {
  constructor(private readonly store: AgentCredentialService) {}

  async persist(provenance: AuthRefreshProvenance, secret: string): Promise<void> {
    const expiresAt = AgentAuthRefreshSink.expiryFromSecret(provenance.provider, secret);
    await this.store.advanceMaterial(provenance.credentialId, secret, expiresAt);
  }

  private static expiryFromSecret(provider: EAgentProvider, secret: string): Date | null {
    if (provider === EAgentProvider.CLAUDE) {
      const ms = parseClaudeExpiresAt(secret);
      return ms ? new Date(ms) : null;
    }
    try {
      const accessToken = (JSON.parse(secret) as { tokens?: { access_token?: string } }).tokens
        ?.access_token;
      const ms = decodeJwtExpMs(accessToken);
      return ms ? new Date(ms) : null;
    } catch {
      return null;
    }
  }
}
