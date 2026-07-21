import { Injectable } from '@nestjs/common';
import { EAgentCredentialKind, type EAgentProvider } from '@workspace/shared';
import { AgentCredentialRefreshService } from './agent-credential-refresh.service';
import { AgentCredentialService } from './agent-credential.service';

export interface ResolvedAgentAuth {
  credentialId: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  material: string;
}

/** The agent-auth slice of a turn's environment: env overrides (`null` = unset) plus, for `personal` OAuth,
 * the raw `.credentials.json` the engine writes to `CLAUDE_CONFIG_DIR`. */
export interface AgentAuthEnv {
  env: Record<string, string | null>;
  credentialsFile?: string;
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

  /**
   * The agent-auth env for a turn, or `null` when the org has no selected credential for the provider. Owns the
   * Claude credential→env translation the engine used to do: a `setup-token` becomes `CLAUDE_CODE_OAUTH_TOKEN`
   * with the metered API-key vars unset; a `personal` login rides `credentialsFile` (the engine writes it).
   */
  async envForTurn(orgId: string, provider: EAgentProvider): Promise<AgentAuthEnv | null> {
    const resolved = await this.resolve(orgId, provider);
    if (!resolved) return null;

    if (resolved.kind === EAgentCredentialKind.PERSONAL) {
      // OAuth login delivered as a `.credentials.json` the SDK reads from CLAUDE_CONFIG_DIR; clear the token var
      // so the file is the sole source. TODO(later): refresh-back of a mid-run rotation to the org credential.
      return { env: { CLAUDE_CODE_OAUTH_TOKEN: null }, credentialsFile: resolved.material };
    }
    // setup-token: a static `sk-ant-oat…` OAuth token. Unset the API-key vars so the harness runs on the
    // subscription token, never a metered API key.
    return {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: resolved.material,
        ANTHROPIC_API_KEY: null,
        ANTHROPIC_AUTH_TOKEN: null,
      },
    };
  }
}
