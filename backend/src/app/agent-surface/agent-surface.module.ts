import { Module } from '@nestjs/common';
import { AgentChatSurface } from './agent-chat-surface';

/**
 * The AGENT-FACING surface providers — the in-process `AgentChatSurface` (W6). NOT `@Global` and binds
 * NOTHING to the `CHAT_SURFACE` token itself: `SurfaceModule` owns that binding (it's the single place
 * the active surface is chosen, gated by `SURFACE`), and it does so via `useExisting:
 * AgentChatSurface` so the SAME instance backs both the port and the programmatic driver API a test
 * grabs with `app.get(AgentChatSurface)`. Importing this module simply makes the provider available;
 * the actual binding decision stays in `SurfaceModule`. Zero v1 imports.
 */
@Module({
  providers: [AgentChatSurface],
  exports: [AgentChatSurface],
})
export class AgentSurfaceModule {}
