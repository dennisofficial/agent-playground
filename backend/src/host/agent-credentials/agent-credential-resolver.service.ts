import { Injectable } from '@nestjs/common';
import type { EAgentCredentialKind, EAgentProvider } from '@workspace/shared';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialService } from './agent-credential.service';

export interface ResolvedAgentAuth {
  credentialId: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  material: string;
}

@Injectable()
export class AgentCredentialResolver {
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
