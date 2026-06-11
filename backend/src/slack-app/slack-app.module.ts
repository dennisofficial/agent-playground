import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { HarnessModule } from '@harness/harness.module';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import {
  GatewaySecretGuard,
  SlackInboundController,
} from './slack-inbound.controller';
import { SlackSurfaceModule } from './slack-surface.module';

/**
 * slack-app = the server entry point: the harness composed headless with the Slack surface bound.
 * Two inbound transports (main.ts branches on SLACK_INBOUND): 'socket' = own Socket Mode
 * connection (single-workspace dev, app context, controller inert); 'gateway' = an HTTP listener
 * the multi-tenant gateway feeds. The TUI remains the local-dev composer — ONE process may
 * compose HarnessModule at a time, and that rule spans all binaries (run slack-app INSTEAD of the
 * tui, never alongside). The api app stays harness-free (admin REST only) so a crash-looping
 * harness can't take the config surface down with it.
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
  controllers: [SlackInboundController],
  providers: [GatewaySecretGuard],
})
export class SlackAppModule {}
