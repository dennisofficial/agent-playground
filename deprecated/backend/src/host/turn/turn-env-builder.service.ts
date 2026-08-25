import { Injectable } from '@nestjs/common';
import type { TurnEnvContext, TurnEnvContributor } from '@shared/engine/turn-env';
import { AgentAuthEnvProvider } from '../agent-credentials/agent-auth-env.provider';
import { GitAuthEnvProvider } from '../github/git-auth-env.provider';

/** The assembled env for a turn: the merged {@link TurnSpec.env} bag plus the optional `credentialsFile`. */
export interface TurnEnv {
  env: Record<string, string | null>;
  credentialsFile?: string;
}

@Injectable()
export class TurnEnvBuilder {
  private readonly contributors: TurnEnvContributor[];

  constructor(agent: AgentAuthEnvProvider, git: GitAuthEnvProvider) {
    this.contributors = [agent, git];
  }

  async build(ctx: TurnEnvContext): Promise<TurnEnv> {
    const env: Record<string, string | null> = {};
    const keyOwner: Record<string, string> = {};
    let credentialsFile: string | undefined;
    let credentialsOwner: string | undefined;

    for (const contributor of this.contributors) {
      const fragment = await contributor.contribute(ctx);
      if (!fragment) continue;

      for (const [key, value] of Object.entries(fragment.env)) {
        const prior = keyOwner[key];
        if (prior && prior !== fragment.source) {
          throw new Error(`turn-env key collision on '${key}': ${prior} vs ${fragment.source}`);
        }
        env[key] = value;
        keyOwner[key] = fragment.source;
      }

      if (fragment.credentialsFile !== undefined) {
        if (credentialsOwner) {
          throw new Error(
            `turn-env credentialsFile collision: ${credentialsOwner} vs ${fragment.source}`,
          );
        }
        credentialsFile = fragment.credentialsFile;
        credentialsOwner = fragment.source;
      }
    }

    return { env, credentialsFile };
  }
}
