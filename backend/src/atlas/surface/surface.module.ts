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
import { AtlasWebSurface } from './atlas-web-surface';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import { CompositeChatSurface } from './composite-chat-surface';
import { parseEnabledSurfaces, type SurfaceId } from './enabled-surfaces';
import { SlackInstallationStore } from './slack-installation.store';
import { WebSurfaceModule } from './web-surface.module';
import {
  ATLAS_SLACK_SOCKET_CLIENT,
  ATLAS_SLACK_WEB_CLIENT,
  ATLAS_SLACK_WEB_CLIENT_FACTORY,
  type SlackWebClientFactory,
  type SlackWebClientLike,
} from './slack.tokens';

/**
 * The Atlas v2 SURFACE module — binds a `CompositeChatSurface` over the ENABLED adapter set (gated by
 * `ATLAS_SURFACES` comma-list, or the legacy single `ATLAS_SURFACE` alias: `slack` default | `agent` |
 * `web`), so SEVERAL surfaces can be live at once. For the multi-workspace Slack adapter it also binds
 * the pieces that let it post AS each tenant:
 *  - `ATLAS_SLACK_WEB_CLIENT` — the optional ENV fallback bot (single-tenant dev / headless);
 *  - `ATLAS_SLACK_SOCKET_CLIENT` — the ONE app-level socket that fans in ALL workspaces' events;
 *  - `ATLAS_SLACK_WEB_CLIENT_FACTORY` — builds a per-workspace Web client from a bot token;
 *  - `SlackInstallationStore` — the encrypted per-workspace bot-token store the factory reads.
 *
 * `WebSurfaceModule` is always imported: it provides `AtlasWebSurface` + mounts the SSE/REST controller
 * (`GET /web/events`, `POST /web/say`, `POST /web/approve`, `GET /web/thread`); the control endpoints
 * self-gate on whether `web` is in the enabled set. The approval-click bridge (`approval$` →
 * `DecisionApprovalService.resolve`) lives there too — no circular dep.
 *
 * @Global so the brain/driver/bridge inject `CHAT_SURFACE` anywhere. All candidate surfaces are always
 * constructed (cheap); only the enabled SET (and thus the composite's membership) varies. Slack creds
 * reuse v1's values when the Atlas-specific ones are unset. Zero v1 imports.
 */
@Global()
@Module({
  imports: [
    AgentSurfaceModule,
    WebSurfaceModule,
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
      // The active surface: a `CompositeChatSurface` over the ENABLED adapter set (`ATLAS_SURFACES`
      // comma-list, or the legacy single `ATLAS_SURFACE` alias, default 'slack'). Several surfaces can
      // be live at once (e.g. 'web,slack'); the composite dispatches outbound by `PostOptions.surfaceId`
      // and merges every adapter's inbound. All candidate adapters are always constructed (cheap); the
      // enabled SET is what varies.
      provide: CHAT_SURFACE,
      inject: [EnvService, AtlasSlackSurface, AgentChatSurface, AtlasWebSurface],
      useFactory: (
        env: EnvService,
        slack: AtlasSlackSurface,
        agent: AgentChatSurface,
        web: AtlasWebSurface,
      ): ChatSurface => {
        const enabled = parseEnabledSurfaces({
          surfaces: env.get('ATLAS_SURFACES'),
          surface: env.get('ATLAS_SURFACE'),
        });
        const byId: Record<SurfaceId, ChatSurface> = { slack, web, agent };
        return new CompositeChatSurface(enabled.map((id) => byId[id]));
      },
    },
  ],
  // Export the Slack surface + installation store so the OAuth controller + interactivity bridge use them.
  // Also export WebSurfaceModule so callers can reach AtlasWebSurface directly if needed.
  exports: [CHAT_SURFACE, AtlasSlackSurface, SlackInstallationStore, AgentSurfaceModule, WebSurfaceModule],
})
export class SurfaceModule {}
