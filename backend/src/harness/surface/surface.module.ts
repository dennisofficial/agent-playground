import { CreateModule } from '@workspace/nestjs-core';
import { ChannelModule } from '../channel/channel.module';
import { ConductorModule } from '../conductor/conductor.module';
import { SurfaceBridge } from './surface-bridge.service';

/**
 * The chat-surface seam. The port (CHAT_SURFACE + ChatSurface) lives in chat-surface.port.ts; the
 * hosting app binds an adapter to the token (TuiChatSurface today, a Slack adapter later) and this
 * bridge wires it to the conductor. No adapter bound → harness runs headless.
 */
@CreateModule({
  imports: [ConductorModule, ChannelModule],
  services: [SurfaceBridge],
})
export class SurfaceModule {}
