import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';

/**
 * tui = the terminal entry point. Boots as a headless standalone context (no HTTP
 * server). Placeholder for now — the Ink renderer + the migrated conductor/harness
 * land in the harness-migration pass, at which point this app boots the same harness
 * module the api does and subscribes to its event stream to render the terminal UI.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
  ],
})
export class TuiModule {}
