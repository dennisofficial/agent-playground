import { EnvService } from '@core/config/env/env.service';
import { ChannelModule } from '@harness/channel/channel.module';
import { ConductorModule } from '@harness/conductor/conductor.module';
import { EmployeesModule } from '@harness/employees/employees.module';
import { LlmKeysModule } from '@harness/llm-keys/llm-keys.module';
import { ProjectsModule } from '@harness/projects/projects.module';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { SlackIdentitiesModule } from '@harness/slack-identities/slack-identities.module';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocketModeClient } from '@slack/socket-mode';
import { Tenant } from '@workspace/shared/schemas';
import { JarvisService } from './jarvis/jarvis.service';
import { LeadPresenceService } from './lead-presence.service';
import { SlackChatSurface } from './slack-chat-surface';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackIdentityRegistry } from './slack-identity.registry';
import { SlackInboundRouter } from './slack-inbound.router';
import { JARVIS_INTERCEPTOR } from './slack-inbound.types';
import { SlackSocketTransport } from './slack-socket-transport';
import { SLACK_SOCKET_MODE_CLIENT } from './slack.tokens';
import { TenantStore } from './tenant.store';
import { TenantSlackClients } from './tenant-slack-clients';

/**
 * Binds the Slack adapter to the harness's CHAT_SURFACE token — the Slack twin of
 * TuiSurfaceModule, @Global for the same reason (the harness's SurfaceBridge optionally injects
 * the token from ITS module scope; a global export is how the hosting app's binding reaches it).
 * The SDK clients are factory providers off EnvService; main.ts asserts the tokens exist before
 * the Nest context is even created, so the factories never see undefined in practice.
 */
@Global()
@Module({
  imports: [
    ConductorModule,
    ChannelModule,
    EmployeesModule,
    LlmKeysModule,
    ProjectsModule,
    SlackIdentitiesModule,
    TypeOrmModule.forFeature([Tenant]),
  ],
  providers: [
    SecretCipher,
    TenantStore,
    TenantSlackClients,
    {
      // Socket Mode client only in dev (SLACK_APP_TOKEN set); prod (Events API) has no socket —
      // the transport provider is @Optional about it and main.ts never calls connect() there.
      provide: SLACK_SOCKET_MODE_CLIENT,
      useFactory: (env: EnvService) => {
        // Socket Mode only in dev (SLACK_APP_TOKEN set). In prod (Events API ingress) there is no
        // socket — the transport is @Optional about it and main.ts never calls connect().
        const appToken = env.get('SLACK_APP_TOKEN');
        return appToken ? new SocketModeClient({ appToken }) : undefined;
      },
      inject: [EnvService],
    },
    SlackDirectoryService,
    SlackIdentityRegistry,
    LeadPresenceService,
    SlackChatSurface,
    SlackInboundRouter,
    SlackSocketTransport,
    JarvisService,
    { provide: JARVIS_INTERCEPTOR, useExisting: JarvisService },
    { provide: CHAT_SURFACE, useExisting: SlackChatSurface },
  ],
  exports: [
    CHAT_SURFACE,
    SlackChatSurface,
    SlackInboundRouter,
    SlackSocketTransport,
  ],
})
export class SlackSurfaceModule {}
