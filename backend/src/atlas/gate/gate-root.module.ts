import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { AtlasDatabaseModule } from '../persistence/atlas-database.module';
import { GateModule } from './gate.module';

/**
 * Standalone composition root for the W1 acceptance gate CLI (`atlas:gate`). It brings up what the gate
 * needs — Env + Logger + the `atlas` datasource + the GateModule (engine + git + surface + runner).
 * The runner persists/resumes session state via the `AtlasPhase` repository on the 'atlas' connection,
 * so the (@Global) AtlasDatabaseModule must be present. Zero v1 imports.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    AtlasDatabaseModule,
    GateModule,
  ],
})
export class GateRootModule {}
