import { EnvService } from '@core/config/env/env.service';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { EsmModule } from '../_lib/esm/esm.module';
import { RedisModule } from '../_lib/redis/redis.module';
import { daemonEnvValidation } from './env.validation';
import { DaemonEnginesModule } from './engines/daemon-engines.module';
import { DaemonGitModule } from './git/daemon-git.module';
import { DaemonRpcModule } from './rpc/daemon-rpc.module';

/**
 * The DAEMON = the in-container NestJS app that runs Claude/Codex engine turns inside an isolated
 * sandbox with NO database access. This module composes the MINIMAL graph that supports that:
 *
 *  - `LoggerModule` — the house logger.
 *  - `EnvModule.forRoot` — provides the global env accessor. We bind the HOST `EnvService` class (the
 *    exact token the verbatim engines + skill loader inject) but validate it with the daemon's MINIMAL
 *    `daemonEnvValidation` (no Postgres/Slack/gateway/JWT vars — the daemon needs none of them). The
 *    host `EnvService` is typed over the host `IEnvConfig`; the daemon-read keys (WORKER_MODEL,
 *    CODEX_MODEL, AGENT_HOME_ROOT) are a subset present in both, so the engines resolve correctly.
 *  - `EsmModule` — the lazy-loaded ESM SDK tokens (ANTHROPIC_AGENT_SDK / OPENAI_CODEX_SDK), VERBATIM.
 *  - `DaemonEnginesModule` — claude + codex engines, the langgraph-free registry, and the DB-free
 *    `DaemonAgentToolsProvider`.
 *
 * DELIBERATELY ABSENT (vs the host harness): `DatabaseModule`, `MemoryModule`, `ConductorModule`,
 * `ChannelModule`, the DB-backed `SkillsModule`, and the roster. The daemon never touches Postgres.
 *
 *  - `DaemonGitModule` — the single-repo git owner (`DaemonGitService`) + the pluggable git credential
 *    provider (`EnvGitCredentialProvider` behind `GIT_CREDENTIAL_PROVIDER`) + the verbatim
 *    `GithubApiService` PR client. This is the daemon's entire git surface (clone/worktree/shared/
 *    publish/PR), keyed by session id inside the one clone.
 *
 *  - `RedisModule` — the shared, resilient/lazy `ioredis` client + the `REDIS_STREAM_PORT` transport seam
 *    (Phase 5). `@Global`, so the daemon's consumer loop + dispatchers inject the port without re-import.
 *  - `DaemonRpcModule` — the Redis communication layer: the `OnApplicationBootstrap` consumer loop
 *    (`ws:{WORKSPACE_ID}:cmds`) + the run/git dispatchers that drive the engines and the git service.
 *
 * The lazy Redis client means the daemon BOOTS even with Redis absent (the consumer loop retries) —
 * the Phase-3 boot smoke (daemon.module.spec) still passes with no Redis.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: daemonEnvValidation,
    }),
    EsmModule,
    RedisModule,
    DaemonEnginesModule,
    DaemonGitModule,
    DaemonRpcModule,
  ],
})
export class DaemonModule {}
