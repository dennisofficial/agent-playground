import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';
import { AgentSurfaceModule } from '../agent-surface/agent-surface.module';
import { AtlasWebSurface } from './atlas-web-surface';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import { WebSurfaceModule } from './web-surface.module';

/**
 * The Atlas v2 SURFACE module — binds the active `ChatSurface`. Atlas talks to people over ONE surface:
 * the web SSE/REST adapter (`AtlasWebSurface`) in production, the in-process `AgentChatSurface` in
 * tests/e2e (selected by `ATLAS_SURFACE=agent`). `WebSurfaceModule` provides `AtlasWebSurface` + mounts
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
      inject: [EnvService, AgentChatSurface, AtlasWebSurface],
      useFactory: (
        env: EnvService,
        agent: AgentChatSurface,
        web: AtlasWebSurface,
      ): ChatSurface => (env.get('ATLAS_SURFACE') === 'agent' ? agent : web),
    },
  ],
  exports: [CHAT_SURFACE, AgentSurfaceModule, WebSurfaceModule],
})
export class SurfaceModule {}
