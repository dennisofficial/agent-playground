import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogLevel, WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';
import { AgentSurfaceModule } from '../agent-surface/agent-surface.module';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasSlackInstallation } from '../persistence/entities';
import { AtlasSlackSurface } from './atlas-slack-surface';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import { SlackInstallationStore } from './slack-installation.store';
import {
  ATLAS_SLACK_SOCKET_CLIENT,
  ATLAS_SLACK_WEB_CLIENT,
  ATLAS_SLACK_WEB_CLIENT_FACTORY,
  type SlackWebClientFactory,
  type SlackWebClientLike,
} from './slack.tokens';

/**
 * The Atlas v2 SURFACE module — binds the active `ChatSurface` (gated by `ATLAS_SURFACE`: `slack`
 * default | `agent`) and, for the multi-workspace Slack adapter, the pieces that let it post AS each
 * tenant:
 *  - `ATLAS_SLACK_WEB_CLIENT` — the optional ENV fallback bot (single-tenant dev / headless);
 *  - `ATLAS_SLACK_SOCKET_CLIENT` — the ONE app-level socket that fans in ALL workspaces' events;
 *  - `ATLAS_SLACK_WEB_CLIENT_FACTORY` — builds a per-workspace Web client from a bot token;
 *  - `SlackInstallationStore` — the encrypted per-workspace bot-token store the factory reads.
 *
 * @Global so the brain/driver/bridge inject `CHAT_SURFACE` anywhere. Both candidate surfaces are always
 * constructed (cheap); only the BINDING is switched. Slack creds reuse v1's values when the Atlas-
 * specific ones are unset. Zero v1 imports.
 */
@Global()
@Module({
  imports: [
    AgentSurfaceModule,
    TypeOrmModule.forFeature([AtlasSlackInstallation], ATLAS_CONNECTION),
  ],
  providers: [
    {
      provide: ATLAS_SLACK_WEB_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const token = env.get('ATLAS_SLACK_BOT_TOKEN') ?? env.get('SLACK_BOT_TOKEN');
        return token ? new WebClient(token, { logLevel: LogLevel.WARN }) : undefined;
      },
    },
    {
      provide: ATLAS_SLACK_SOCKET_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService) => {
        const appToken = env.get('ATLAS_SLACK_APP_TOKEN') ?? env.get('SLACK_APP_TOKEN');
        return appToken ? new SocketModeClient({ appToken }) : undefined;
      },
    },
    {
      // Builds a workspace-scoped Web client from its OAuth bot token (used for per-tenant posting).
      provide: ATLAS_SLACK_WEB_CLIENT_FACTORY,
      useFactory: (): SlackWebClientFactory => (token: string) =>
        new WebClient(token, { logLevel: LogLevel.WARN }) as unknown as SlackWebClientLike,
    },
    SlackInstallationStore,
    AtlasSlackSurface,
    {
      // The active surface: 'agent' binds the programmatic one, anything else (default) binds Slack.
      provide: CHAT_SURFACE,
      inject: [EnvService, AtlasSlackSurface, AgentChatSurface],
      useFactory: (
        env: EnvService,
        slack: AtlasSlackSurface,
        agent: AgentChatSurface,
      ): ChatSurface => (env.get('ATLAS_SURFACE') === 'agent' ? agent : slack),
    },
  ],
  // Export the Slack surface + installation store so the OAuth controller + interactivity bridge use them.
  exports: [CHAT_SURFACE, AtlasSlackSurface, SlackInstallationStore, AgentSurfaceModule],
})
export class SurfaceModule {}
