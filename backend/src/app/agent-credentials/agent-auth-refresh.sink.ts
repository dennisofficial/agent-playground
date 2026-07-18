import { Injectable } from '@nestjs/common';
import { EAgentProvider } from '@workspace/shared';
import { AgentCredentialService } from './agent-credential.service';
import { decodeJwtExpMs } from './oauth/codex-id-token';
import { parseClaudeExpiresAt } from './oauth/material-freshness';
import type { AuthRefreshProvenance, AuthRefreshSink } from './ports/auth-refresh-sink.port';

/**
 * Persists a token the engine's SDK rotated mid-run ({@link AuthRefreshSink}). Derives the new expiry from
 * the secret itself and hands it to the store, which writes it only if it's newer than what's held — so a
 * slow write-back never clobbers a fresher token. Bound to `AUTH_REFRESH_SINK`.
 */
@Injectable()
export class AgentAuthRefreshSink implements AuthRefreshSink {
  constructor(private readonly store: AgentCredentialService) {}

  async persist(provenance: AuthRefreshProvenance, secret: string): Promise<void> {
    const expiresAt = expiryFromSecret(provenance.provider, secret);
    await this.store.advanceMaterial(provenance.credentialId, secret, expiresAt);
  }
}

function expiryFromSecret(provider: EAgentProvider, secret: string): Date | null {
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
