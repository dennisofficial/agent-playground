import { Module } from '@nestjs/common';
import { GitIdentityService } from './git-identity.service';
import { GitHubAppTokenService } from './github-app-token.service';
import { GithubPrService } from './github-pr.service';
import { LocalGitService } from './local-git.service';

@Module({
  providers: [LocalGitService, GithubPrService, GitIdentityService, GitHubAppTokenService],
  exports: [LocalGitService, GithubPrService, GitIdentityService, GitHubAppTokenService],
})
export class GitModule {}
