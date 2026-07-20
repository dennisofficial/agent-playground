import { Injectable } from '@nestjs/common';
import type { EAgentCredentialKind, EAgentProvider } from '@workspace/shared';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialService } from './agent-credential.service';

export interface ResolvedAgentAuth {
  credentialId: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  /**
   * Decrypted material to materialize into an engine home: Claude personal → the `.credentials.json`
   * JSON string; Claude setup_token → the raw `sk-ant-oat…` token; Codex → the `auth.json` blob.
   */
  material: string;
}

/**
 * The engine's read seam: resolves the selected account for a provider and hands back fresh, decrypted
 * runtime material — refreshing first if the token is near expiry. Exported directly (no port); the future
 * engine injects it across the app↔engine boundary, which is where a seam gets reintroduced if needed.
 */
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
