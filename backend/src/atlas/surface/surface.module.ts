import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { LogLevel, WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';
import { AgentSurfaceModule } from '../agent-surface/agent-surface.module';
import { AtlasSlackSurface } from './atlas-slack-surface';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import {
  ATLAS_SLACK_SOCKET_CLIENT,
  ATLAS_SLACK_WEB_CLIENT,
} from './slack.tokens';

/**
 * The Atlas v2 SURFACE module — THE single place the active `ChatSurface` is chosen and bound to the
 * `CHAT_SURFACE` token, gated by `ATLAS_SURFACE` (`slack` default | `agent`):
 *
 *  - `slack` — the thread-aware `AtlasSlackSurface` over a real Slack channel (W1). Slack SDK clients
 *    are factory providers off EnvService (so the adapter never reads env or constructs SDK clients
 *    itself — testable in isolation). Both are OPTIONAL: no bot token → inert (headless), bot token but
 *    no app token → post-only (no inbound socket).
 *  - `agent` — the in-process `AgentChatSurface` (W6): a program/test drives Atlas (send → read replies
 *    → approve) with NO Slack. The same instance backs both the `CHAT_SURFACE` port and the driver API
 *    a test grabs via `app.get(AgentChatSurface)` (`useExisting`).
 *
 * @Global so the brain/driver/bridge inject `CHAT_SURFACE` anywhere. Both candidate surfaces are always
 * constructed (cheap — the Slack one is inert without tokens, the agent one is pure in-memory); only the
 * BINDING is switched, so flipping `ATLAS_SURFACE` is the sole change between modes. Zero v1 imports.
 *
 * Slack credentials reuse v1's values when the Atlas-specific ones are unset: ATLAS_SLACK_BOT_TOKEN ⇢
 * SLACK_BOT_TOKEN, ATLAS_SLACK_APP_TOKEN ⇢ SLACK_APP_TOKEN.
 */
@Global()
@Module({
  imports: [AgentSurfaceModule],
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
  // Re-export AgentSurfaceModule (not the bare provider — it's owned by that module) so a test can
  // `app.get(AgentChatSurface)` to drive Atlas; the brain/driver/bridge inject CHAT_SURFACE.
  exports: [CHAT_SURFACE, AtlasSlackSurface, AgentSurfaceModule],
})
export class SurfaceModule {}
