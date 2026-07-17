import { CreateModule } from '@workspace/nestjs-core';
import { CredentialsModule } from '../credentials/credentials.module';
import { GITHUB_ACCESS_PORT } from '../repo/ports/github-access.port';
import { GithubAccessAdapter } from './github-access.adapter';
import { GithubApiService } from './github-api.service';
import { GithubCredentialsService } from './github-credentials.service';

/**
 * The isolated GitHub feature. Phase 1: it provides the repos slice's {@link GITHUB_ACCESS_PORT} with a
 * real PAT-backed implementation (replacing the Noop), so connecting a repo actually validates access
 * and lists live branches. It imports {@link CredentialsModule} for the org's stored PAT and exports the
 * port binding + {@link GithubCredentialsService} (the future sandbox/brain token seam).
 */
@CreateModule({
  imports: [CredentialsModule],
  services: [GithubCredentialsService], // exported — the git-auth seam for future consumers
  providers: [GithubApiService, { provide: GITHUB_ACCESS_PORT, useClass: GithubAccessAdapter }],
  exports: [GITHUB_ACCESS_PORT],
})
export class GithubModule {}
