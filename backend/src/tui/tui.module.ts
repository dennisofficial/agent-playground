import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { HarnessModule } from '@harness/harness.module';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import { TuiSurfaceModule } from './tui-surface.module';

/**
 * tui = the terminal entry point. Boots as a headless standalone context (no HTTP
 * server), composes the harness via DI, and renders it with Ink. This folder holds
 * ONLY terminal-interface logic — the harness itself is app-agnostic (`src/harness`)
 * and the api app will compose the same module once the Slack adapter lands.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    DatabaseModule,
    EsmModule,
    HarnessModule,
    TuiSurfaceModule,
  ],
})
export class TuiModule {}
