import { Injectable } from '@nestjs/common';
import { EJitDelivery, EJitTrigger, JitHook } from '@shared/jit/jit.decorator';

// TODO: Needs rework
@Injectable()
export class InstallAwarenessRule {
  @JitHook({
    id: 'install-awareness',
    trigger: EJitTrigger.TOOL_MATCH,
    delivery: EJitDelivery.POST_TOOL_USE,
  })
  handle(_context: unknown): string | null {
    return null;
  }
}
