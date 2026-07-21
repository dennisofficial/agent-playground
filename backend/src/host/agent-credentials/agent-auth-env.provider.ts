import { Injectable } from '@nestjs/common';
import type { TurnEnvContext, TurnEnvContributor, TurnEnvFragment } from '@shared/engine/turn-env';
import { EAgentProvider } from '@workspace/shared';
import { AgentCredentialResolver } from './agent-credential-resolver.service';

@Injectable()
export class AgentAuthEnvProvider implements TurnEnvContributor {
  constructor(private readonly resolver: AgentCredentialResolver) {}

  async contribute({ orgId }: TurnEnvContext): Promise<TurnEnvFragment> {
    const auth = await this.resolver.envForTurn(orgId, EAgentProvider.CLAUDE);
    if (!auth) throw new Error(`no Claude credential selected for org ${orgId}`);
    return { source: 'agent-claude', env: auth.env, credentialsFile: auth.credentialsFile };
  }
}
