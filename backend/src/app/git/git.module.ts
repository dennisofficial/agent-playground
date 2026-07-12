import { Module } from '@nestjs/common';
import { LocalGitService } from './local-git.service';
import { GithubPrService } from './github-pr.service';
import { GitIdentityService } from './git-identity.service';
import { GitHubAppTokenService } from './github-app-token.service';

/**
 * The Atlas v2 GIT module — the host-only (daemon-free, Docker-free) local git substrate
 * (`LocalGitService`: clone/locate, per-feature worktree, commit, push) + the fetch-based GitHub PR
 * client (`GithubPrService`) + the PAT → commit-identity resolver (`GitIdentityService`) + the GitHub App
 * installation-token client (`GitHubAppTokenService`). Replaces v1's daemon-gated WorkspaceGitProvider /
 * ReviewPipelineService ship path. Zero v1 imports.
 */
@Module({
  providers: [
    LocalGitService,
    GithubPrService,
    GitIdentityService,
    GitHubAppTokenService,
  ],
  exports: [
    LocalGitService,
    GithubPrService,
    GitIdentityService,
    GitHubAppTokenService,
  ],
})
export class GitModule {}
