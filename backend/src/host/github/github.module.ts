import { CreateModule } from '@workspace/nestjs-core';
import { OrgCredentialsModule } from '../org-credentials/credentials.module';
import { GithubAccessAdapter } from './github-access.adapter';
import { GithubApiService } from './github-api.service';
import { GithubCredentialsService } from './github-credentials.service';

/**
 * The isolated GitHub feature. Phase 1: a real PAT-backed {@link GithubAccessAdapter} (repo validation +
 * live branches) that the repos slice injects directly. It imports {@link OrgCredentialsModule} for the
 * org's stored PAT and exports the adapter + {@link GithubCredentialsService} (the future sandbox/brain
 * token seam).
 */
@CreateModule({
  imports: [OrgCredentialsModule],
  // exported — GithubAccessAdapter is the repos-slice seam; GithubCredentialsService the git-auth seam.
  services: [GithubCredentialsService, GithubAccessAdapter],
  providers: [GithubApiService],
})
export class GithubModule {}
