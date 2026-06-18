import { CreateModule } from '@workspace/nestjs-core';
import { GithubApiService } from '@harness/projects/github-api.service';
import { DaemonGitService } from './daemon-git.service';
import {
  EnvGitCredentialProvider,
  GIT_CREDENTIAL_PROVIDER,
} from './git-credential.provider';

/**
 * The daemon's git module — wires the single-repo `DaemonGitService` with its two collaborators:
 *  - `GIT_CREDENTIAL_PROVIDER` bound to `EnvGitCredentialProvider` (PAT from the ambient env). Phase 5
 *    swaps in a Redis-pull impl behind this same token without touching `DaemonGitService`.
 *  - `GithubApiService` — REUSED VERBATIM from the host (a zero-dep, constructor-less fetch PR client),
 *    instantiated here for `openPr`/`markReady`.
 *
 * `services` auto-exports `DaemonGitService` so the Phase 5 consumer loop (git RPCs) and a future
 * readiness path (`ensureClone`) can inject it. No DB, no lifecycle hook — the clone is created on
 * demand.
 */
@CreateModule({
  services: [DaemonGitService, EnvGitCredentialProvider, GithubApiService],
  chains: [
    {
      provide: GIT_CREDENTIAL_PROVIDER,
      useExisting: EnvGitCredentialProvider,
    },
  ],
})
export class DaemonGitModule {}
