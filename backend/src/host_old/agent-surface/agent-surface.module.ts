import { Module } from '@nestjs/common';
import { AgentChatSurface } from './agent-chat-surface';

@Module({
  providers: [AgentChatSurface],
  exports: [AgentChatSurface],
})
export class AgentSurfaceModule {}
