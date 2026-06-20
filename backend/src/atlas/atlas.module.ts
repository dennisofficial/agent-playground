import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { AppModule } from './app/app.module';
import { PersistenceModule } from './persistence/persistence.module';

/**
 * AtlasModule — the clean-room root for the v2 orchestrator ("Atlas v2"). A LEGIBLE rebuild of the
 * proven semantics (section-driver, JIT planning, one PR) + the reactive notification path, with a
 * deterministic pipeline you can read top-to-bottom and an LLM brain that only decides whether/what.
 *
 * THE HARD RULE: ZERO import edges into v1 — nothing here (or anywhere under `src/atlas/`) imports
 * from `@harness/**` or the v1 `slack-app` surface. Shared FOUNDATIONAL packages are fair game
 * (`EnvService`/validation, `@workspace/nestjs-core`, `@workspace/shared` base entity), but NOT v1
 * orchestration — anything wanted from v1 is copied/rewritten into `atlas/` and owned.
 *
 * It also does NOT import the global `DatabaseModule` (the shared default connection): Atlas owns its
 * OWN named TypeORM connection ('atlas') via `PersistenceModule` → `AtlasDatabaseModule`, loading only
 * the `atlas_*` entities. Composed by its OWN entrypoint (`atlas-main.ts`), never by `slack-app`.
 *
 * The submodule layout — `domain/` (in-memory types), `persistence/` (the datasource + entities),
 * `app/` (the edge: surfaces + ingress) — is the home for the workstreams to come (W1+).
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    PersistenceModule,
    AppModule,
  ],
})
export class AtlasModule {}
