import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { HarnessModule } from '@harness/harness.module';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { SlackIdentitiesModule } from '@harness/slack-identities/slack-identities.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { Tenant } from '@workspace/shared/schemas';
import { DatabaseModule } from '../_lib/database/database.module';
import { EsmModule } from '../_lib/esm/esm.module';
import { SlackCommandsController } from './slack-commands.controller';
import { SlackEventsController } from './slack-events.controller';
import { SlackInteractivityController } from './slack-interactivity.controller';
import { SlackOauthController } from './slack-oauth.controller';
import { SlackPuppetOauthController } from './slack-puppet-oauth.controller';
import { SlackSignatureGuard } from './slack-signature.guard';
import { SlackSurfaceModule } from './slack-surface.module';
import { TenantStore } from './tenant.store';

/**
 * slack-app = THE server: the harness composed headless with the Slack surface bound AND the
 * public Slack ingress (events / interactivity / oauth, signature-verified) dispatching IN-PROCESS
 * — one process serves every workspace (single-process multi-tenant; no gateway hop, no per-tenant
 * stacks). Dev still runs Socket Mode (main.ts connects it when SLACK_APP_TOKEN is set); prod is
 * the OAuth-distributed Events API app whose one connection feeds these controllers, routed by
 * team_id. The TUI remains the local-dev composer — ONE process composes HarnessModule at a time.
 * The api app stays a thin harness-free sibling (admin REST) sharing this database.
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
    SlackIdentitiesModule,
    TypeOrmModule.forFeature([Tenant]),
  ],
  controllers: [
    SlackEventsController,
    SlackInteractivityController,
    SlackCommandsController,
    SlackOauthController,
    SlackPuppetOauthController,
  ],
  providers: [SlackSignatureGuard, SecretCipher, TenantStore],
})
export class SlackAppModule {}
