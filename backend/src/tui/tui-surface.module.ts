import { ConductorModule } from '@harness/conductor/conductor.module';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Global, Module } from '@nestjs/common';
import { TuiChatSurface } from './tui-chat-surface';

/**
 * Binds the terminal adapter to the harness's CHAT_SURFACE token. @Global on purpose: the harness's
 * SurfaceBridge optionally injects the token from ITS module scope, and a global export is how a
 * hosting app's binding reaches it without the harness importing app code (the dependency points
 * app → harness only). The api app will bind its Slack adapter the same way.
 */
@Global()
@Module({
  imports: [ConductorModule],
  providers: [{ provide: CHAT_SURFACE, useClass: TuiChatSurface }],
  exports: [CHAT_SURFACE],
})
export class TuiSurfaceModule {}
