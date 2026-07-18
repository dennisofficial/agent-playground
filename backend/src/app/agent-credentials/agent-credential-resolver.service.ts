import { Injectable } from '@nestjs/common';
import type { EAgentProvider } from '@workspace/shared';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialService } from './agent-credential.service';
import type { AgentAuthPort, ResolvedAgentAuth } from './ports/agent-auth.port';

/**
 * The engine's read seam ({@link AgentAuthPort}). Resolves the selected account for a provider and hands
 * back fresh, decrypted runtime material — refreshing first if the token is near expiry. Exported behind
 * `AGENT_AUTH_PORT` so the engine never learns how credentials are stored or refreshed.
 */
@Injectable()
export class AgentCredentialResolver implements AgentAuthPort {
  constructor(
    private readonly store: AgentCredentialService,
    private readonly refresh: AgentCredentialRefreshService,
  ) {}

  async resolve(orgId: string, provider: EAgentProvider): Promise<ResolvedAgentAuth | null> {
    const row = await this.store.getSelected(orgId, provider);
    if (!row) return null;
    const material = await this.refresh.ensureFresh(orgId, row.id);
    return { credentialId: row.id, provider, kind: row.kind, material };
  }
}
