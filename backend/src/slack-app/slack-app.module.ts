import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { HarnessModule } from '@harness/harness.module';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import { SlackSurfaceModule } from './slack-surface.module';

/**
 * slack-app = the server entry point: the harness composed headless with the Slack Socket Mode
 * surface bound. The TUI remains the local-dev composer — ONE process may compose HarnessModule
 * at a time, and that rule now spans both binaries (run slack-app INSTEAD of the tui, never
 * alongside). The api app stays harness-free (admin REST only) so a crash-looping harness can't
 * take the config surface down with it.
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
    SlackSurfaceModule,
  ],
})
export class SlackAppModule {}
