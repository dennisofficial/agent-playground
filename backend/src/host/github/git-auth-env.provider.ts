import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import type { TurnEnvContext, TurnEnvContributor, TurnEnvFragment } from '@shared/engine/turn-env';
import { GithubTokenService } from './github-token.service';

@Injectable()
export class GitAuthEnvProvider implements TurnEnvContributor {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly githubTokenService: GithubTokenService,
  ) {}

  async contribute({ orgId, jobId }: TurnEnvContext): Promise<TurnEnvFragment | null> {
    // System/background path (no request user) → unscoped reads.
    const job = await this.prismaService.job.findFirst({ where: { id: jobId } });
    if (!job) return null;
    const repo = await this.prismaService.repo.findFirst({ where: { id: job.repoId } });
    if (!repo) return null;

    return {
      source: 'git-auth',
      env: await this.githubTokenService.gitEnvForTurn(orgId, repo.gitUrl),
    };
  }
}
