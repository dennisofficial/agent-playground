/**
 * prompt-kit / prompt.service — a thin DI facade over the pure assembly core (`assemble.ts`).
 *
 * Its jobs: (1) fail LOUDLY at app boot if the fragment set is misconfigured (`onModuleInit` → `primeFragments`);
 * (2) be injectable where a service prefers DI (e.g. the test-bridge preview). Rendering itself is pure — most
 * call sites use `renderAgentPrompt` directly, and `generate` delegates to it, so there is ONE assembly path.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { Agent } from '@shared/prompt-kit/system/agent';
import { primeFragments, renderAgentPrompt } from '@shared/prompt-kit/system/assemble';
import type { PromptCtx } from '@shared/prompt-kit/system/prompt-ctx';

@Injectable()
export class PromptService implements OnModuleInit {
  onModuleInit(): void {
    primeFragments(); // boot-loud validation (dup order per agent, throwing fragment, …)
  }

  /** Assemble the system prompt for `agent` against `ctx` (delegates to the pure `renderAgentPrompt`). */
  generate(agent: Agent, ctx: PromptCtx = {}): AgentMessage {
    return renderAgentPrompt(agent, ctx);
  }
}
