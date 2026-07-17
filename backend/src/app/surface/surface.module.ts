import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { AgentChatSurface } from '../agent-surface/agent-chat-surface';
import { AgentSurfaceModule } from '../agent-surface/agent-surface.module';
import { CHAT_SURFACE, type ChatSurface } from './chat-surface.port';
import { MESSAGE_CHANGE_NOTIFIER } from './message-change-notifier.port';
import { WebSurface } from './web-surface';
import { WebSurfaceModule } from './web-surface.module';

@Global()
@Module({
  imports: [AgentSurfaceModule, WebSurfaceModule],
  providers: [
    {
      provide: CHAT_SURFACE,
      inject: [EnvService, AgentChatSurface, WebSurface],
      useFactory: (env: EnvService, agent: AgentChatSurface, web: WebSurface): ChatSurface =>
        env.get('SURFACE') === 'agent' ? agent : web,
    },
    { provide: MESSAGE_CHANGE_NOTIFIER, useExisting: WebSurface },
  ],
  exports: [CHAT_SURFACE, MESSAGE_CHANGE_NOTIFIER, AgentSurfaceModule, WebSurfaceModule],
})
export class SurfaceModule {}
