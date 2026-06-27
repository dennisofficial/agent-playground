import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { OrmConnectionModule } from '../persistence/database.module';
import { GateModule } from './gate.module';

/**
 * Standalone composition root for the W1 acceptance gate CLI (`gate`). It brings up what the gate
 * needs — Env + Logger + the `atlas` datasource + the GateModule (engine + git + surface + runner).
 * The runner persists/resumes session state via the `StepEntity` repository on the 'app' connection,
 * so the (@Global) OrmConnectionModule must be present. Zero v1 imports.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    OrmConnectionModule,
    GateModule,
  ],
})
export class GateRootModule {}
