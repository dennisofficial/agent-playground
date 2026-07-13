import { ScheduleModule } from '@nestjs/schedule';
import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { FeaturesModule } from './features.module';
import { PersistenceModule } from './persistence/persistence.module';
import { ProdDiagnosticsModule } from './prod-mcp/prod-diagnostics.module';

/**
 * AppModule — the clean-room root for the v2 orchestrator ("Atlas v2"). A LEGIBLE rebuild of the
 * proven semantics (thread-driver, JIT planning, one PR) + the reactive notification path, with a
 * deterministic pipeline you can read top-to-bottom and an LLM brain that only decides whether/what.
 *
 * THE HARD RULE: ZERO import edges into v1 — nothing here (or anywhere under `src/app/`) imports
 * from `@harness/**` or the v1 `slack-app` surface. Shared FOUNDATIONAL packages are fair game
 * (`EnvService`/validation, `@workspace/nestjs-core`, `@workspace/shared` base entity), but NOT v1
 * orchestration — anything wanted from v1 is copied/rewritten into `atlas/` and owned.
 *
 * It also does NOT import the global `DatabaseModule` (the shared default connection): Atlas owns its
 * OWN named TypeORM connection ('atlas') via `PersistenceModule` → `OrmConnectionModule`, loading only
 * the `app` entities. Composed by its OWN entrypoint (`main.ts`), never by `slack-app`.
 *
 * The submodule layout — `domain/` (in-memory types), `persistence/` (the datasource + entities),
 * `app/` (the edge: surfaces + ingress) — is the home for the workstreams to come (W1+).
 */
@CreateModule({
  imports: [
    LoggerModule,
    // Register @nestjs/schedule once at the root so leader-gated interval timers can register/unregister
    // themselves via SchedulerRegistry (add/deleteInterval) from their onPromote/onDemote hooks.
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    PersistenceModule,
    ProdDiagnosticsModule,
    FeaturesModule,
  ],
})
export class AppModule {}
