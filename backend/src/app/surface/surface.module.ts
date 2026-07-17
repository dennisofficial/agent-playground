import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';
import { AgentSurfaceModule } from '../agent-surface/agent-surface.module';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import { MESSAGE_CHANGE_NOTIFIER } from './message-change-notifier.port';
import { WebSurface } from './web-surface';
import { WebSurfaceModule } from './web-surface.module';

/**
 * The Atlas v2 SURFACE module — binds the active `ChatSurface`. Atlas talks to people over ONE surface:
 * the web SSE/REST adapter (`WebSurface`) in production, the in-process `AgentChatSurface` in
 * tests/e2e (selected by `SURFACE=agent`). `WebSurfaceModule` provides `WebSurface` + mounts
 * the SSE/REST controller (`GET /web/events`, `POST /web/say`, `POST /web/approve`, `GET /web/thread`)
 * and wires the approval-click bridge (`approval$` → `DecisionApprovalService.resolve`) — no circular dep.
 *
 * @Global so the brain/driver/bridge inject `CHAT_SURFACE` anywhere. Both candidate surfaces are always
 * constructed (cheap); only the BINDING is switched. Zero v1 imports.
 */
@Global()
@Module({
  imports: [AgentSurfaceModule, WebSurfaceModule],
  providers: [
    {
      // The active surface: 'agent' binds the in-process programmatic surface (tests/scripts); anything
      // else (default) binds the web SSE/REST adapter — the production surface.
      provide: CHAT_SURFACE,
      inject: [EnvService, AgentChatSurface, WebSurface],
      useFactory: (env: EnvService, agent: AgentChatSurface, web: WebSurface): ChatSurface =>
        env.get('SURFACE') === 'agent' ? agent : web,
    },
    // The message-change notifier is ALWAYS the web surface (it owns the SSE stream), regardless of which
    // ChatSurface is bound — the stimulus seam emits through it best-effort; in `agent` mode nobody reads it.
    { provide: MESSAGE_CHANGE_NOTIFIER, useExisting: WebSurface },
  ],
  exports: [CHAT_SURFACE, MESSAGE_CHANGE_NOTIFIER, AgentSurfaceModule, WebSurfaceModule],
})
export class SurfaceModule {}
