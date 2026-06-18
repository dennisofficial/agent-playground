import { CreateModule } from '@workspace/nestjs-core';
import { GithubApiService } from '@harness/projects/github-api.service';
import { DaemonBootstrapService } from './daemon-bootstrap.service';
import { DaemonGitService } from './daemon-git.service';
import {
  EnvGitCredentialProvider,
  GIT_CREDENTIAL_PROVIDER,
  type GitCredentialProvider,
} from './git-credential.provider';
import { RedisGitCredentialProvider } from './redis-git-credential.provider';

/**
 * The daemon's git module — wires the single-repo `DaemonGitService` with its collaborators:
 *  - `GIT_CREDENTIAL_PROVIDER` bound by a FACTORY that picks the credential source at boot:
 *      • `RedisGitCredentialProvider` (the cred-pull channel, Phase 6) when `REDIS_URL` AND `WORKSPACE_ID`
 *        are both present — i.e. running as a real sandbox daemon; the host serves the GitHub credential
 *        just-in-time over Redis, so nothing sensitive is baked into the image/env.
 *      • `EnvGitCredentialProvider` (the PAT-from-env path) otherwise — keeps dev/local/standalone runs
 *        working with `GIT_TOKEN` in the ambient env, no Redis/host required.
 *    Either way `DaemonGitService` is untouched (it injects the SAME token + async `resolve()` contract).
 *  - `GithubApiService` — REUSED VERBATIM from the host (a zero-dep fetch PR client) for `openPr`/`markReady`.
 *
 * `services` auto-exports `DaemonGitService` so the consumer loop (git RPCs) + readiness path inject it.
 *
 * `DaemonBootstrapService` (`OnApplicationBootstrap`) is the clone-on-boot step (Phase 11): once this
 * module is in the daemon graph it clones the host-injected repo (`WORKSPACE_REPO_URL` /
 * `WORKSPACE_BASE_BRANCH`) into `WORKSPACE_ROOT` and arms `DaemonGitService`'s clone gate so the
 * readiness marker isn't written until the clone completes.
 */
@CreateModule({
  services: [DaemonGitService, GithubApiService, DaemonBootstrapService],
  providers: [EnvGitCredentialProvider, RedisGitCredentialProvider],
  chains: [
    {
      provide: GIT_CREDENTIAL_PROVIDER,
      // WORKSPACE_ID + REDIS_URL present → pull credentials from the host over Redis; else env-PAT.
      useFactory: (
        envProvider: EnvGitCredentialProvider,
        redisProvider: RedisGitCredentialProvider,
      ): GitCredentialProvider =>
        process.env.WORKSPACE_ID?.trim() && process.env.REDIS_URL?.trim()
          ? redisProvider
          : envProvider,
      inject: [EnvGitCredentialProvider, RedisGitCredentialProvider],
    },
  ],
})
export class DaemonGitModule {}
