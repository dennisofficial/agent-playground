import { EnvService } from '@core/config/env/env.service';
import { ChannelModule } from '@harness/channel/channel.module';
import { ConductorModule } from '@harness/conductor/conductor.module';
import { EmployeesModule } from '@harness/employees/employees.module';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Global, Module } from '@nestjs/common';
import { SocketModeClient } from '@slack/socket-mode';
import { LogLevel, WebClient } from '@slack/web-api';
import { SlackChatSurface } from './slack-chat-surface';
import { SlackDirectoryService } from './slack-directory.service';
import { SLACK_SOCKET_MODE_CLIENT, SLACK_WEB_CLIENT } from './slack.tokens';

/**
 * Binds the Slack adapter to the harness's CHAT_SURFACE token — the Slack twin of
 * TuiSurfaceModule, @Global for the same reason (the harness's SurfaceBridge optionally injects
 * the token from ITS module scope; a global export is how the hosting app's binding reaches it).
 * The SDK clients are factory providers off EnvService; main.ts asserts the tokens exist before
 * the Nest context is even created, so the factories never see undefined in practice.
 */
@Global()
@Module({
  imports: [ConductorModule, ChannelModule, EmployeesModule],
  providers: [
    {
      provide: SLACK_WEB_CLIENT,
      useFactory: (env: EnvService) =>
        new WebClient(env.get('SLACK_BOT_TOKEN'), { logLevel: LogLevel.WARN }),
      inject: [EnvService],
    },
    {
      provide: SLACK_SOCKET_MODE_CLIENT,
      useFactory: (env: EnvService) =>
        new SocketModeClient({ appToken: env.get('SLACK_APP_TOKEN')! }),
      inject: [EnvService],
    },
    SlackDirectoryService,
    SlackChatSurface,
    { provide: CHAT_SURFACE, useExisting: SlackChatSurface },
  ],
  exports: [CHAT_SURFACE, SlackChatSurface],
})
export class SlackSurfaceModule {}
