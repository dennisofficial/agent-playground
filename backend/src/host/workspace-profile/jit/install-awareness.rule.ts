import { EJitDelivery, EJitTrigger, JitHook } from '@/shared/jit/jit.decorator';
import { Injectable } from '@nestjs/common';

@Injectable()
export class InstallAwarenessRule {
  @JitHook({
    id: 'install-awareness',
    trigger: EJitTrigger.TOOL_MATCH,
    delivery: EJitDelivery.POST_TOOL_USE,
  })
  handle(_context: unknown): string | null {
    // Stage 1 (deterministic install detect + dedupe ledger) and Stage 2 (LLM noise filter) land later.
    return null;
  }
}
