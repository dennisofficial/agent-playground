import { Module } from '@nestjs/common';
import { LocalGitService } from './local-git.service';
import { GithubPrService } from './github-pr.service';

/**
 * The Atlas v2 GIT module — the host-only (daemon-free, Docker-free) local git substrate
 * (`LocalGitService`: clone/locate, per-feature worktree, commit, push) + the fetch-based GitHub PR
 * client (`GithubPrService`). Replaces v1's daemon-gated WorkspaceGitProvider / ReviewPipelineService
 * ship path. Zero v1 imports.
 */
@Module({
  providers: [LocalGitService, GithubPrService],
  exports: [LocalGitService, GithubPrService],
})
export class GitModule {}
