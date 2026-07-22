import { Injectable } from '@nestjs/common';
import { EAgentProvider } from '@workspace/shared';
import { AgentCredentialService } from './agent-credential.service';
import { CodexAuthService } from './oauth/codex-auth.service';
import { MaterialFreshnessService } from './oauth/material-freshness.service';

export interface AuthRefreshProvenance {
  orgId: string;
  credentialId: string;
  provider: EAgentProvider;
}

@Injectable()
export class AgentAuthRefreshSink {
  constructor(
    private readonly store: AgentCredentialService,
    private readonly codexAuthService: CodexAuthService,
    private readonly materialFreshnessService: MaterialFreshnessService,
  ) {}

  async persist(provenance: AuthRefreshProvenance, secret: string): Promise<void> {
    const expiresAt = this.expiryFromSecret(provenance.provider, secret);
    await this.store.advanceMaterial(provenance.credentialId, secret, expiresAt);
  }

  private expiryFromSecret(provider: EAgentProvider, secret: string): Date | null {
    if (provider === EAgentProvider.CLAUDE) {
      const ms = this.materialFreshnessService.parseClaudeExpiresAt(secret);
      return ms ? new Date(ms) : null;
    }
    try {
      const accessToken = (JSON.parse(secret) as { tokens?: { access_token?: string } }).tokens
        ?.access_token;
      const ms = this.codexAuthService.decodeJwtExpMs(accessToken);
      return ms ? new Date(ms) : null;
    } catch {
      return null;
    }
  }
}
