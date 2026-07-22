import { Job } from '@lib/database/entities/job.entity';
import { Repo } from '@lib/database/entities/repo.entity';
import { Injectable } from '@nestjs/common';
import type { TurnEnvContext, TurnEnvContributor, TurnEnvFragment } from '@shared/engine/turn-env';
import { Db } from '@workspace/nestjs-rls/nest';
import { GithubTokenService } from './github-token.service';

@Injectable()
export class GitAuthEnvProvider implements TurnEnvContributor {
  constructor(
    private readonly db: Db,
    private readonly github: GithubTokenService,
  ) {}

  async contribute({ orgId, jobId }: TurnEnvContext): Promise<TurnEnvFragment | null> {
    // System/background path (no request user) → unscoped reads.
    const job = await this.db.unsafe(Job).findOne({ where: { id: jobId } });
    if (!job) return null;
    const repo = await this.db.unsafe(Repo).findOne({ where: { id: job.repoId } });
    if (!repo) return null;

    return { source: 'git-auth', env: await this.github.gitEnvForTurn(orgId, repo.gitUrl) };
  }
}
