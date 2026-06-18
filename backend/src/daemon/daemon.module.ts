import { EnvService } from '@core/config/env/env.service';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { EsmModule } from '../_lib/esm/esm.module';
import { daemonEnvValidation } from './env.validation';
import { DaemonEnginesModule } from './engines/daemon-engines.module';

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
 * Phase 4 adds the daemon git service; Phase 5 adds the Redis communication layer (consumer loop +
 * dispatcher). This phase is just the skeleton — it must compile and boot.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: daemonEnvValidation,
    }),
    EsmModule,
    DaemonEnginesModule,
  ],
})
export class DaemonModule {}
