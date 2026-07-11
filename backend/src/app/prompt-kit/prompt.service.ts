/**
 * prompt-kit / prompt.service — a thin DI facade over the pure assembly core (`assemble.ts`).
 *
 * Its jobs: (1) fail LOUDLY at app boot if the fragment set is misconfigured (`onModuleInit` → `primeFragments`);
 * (2) be injectable where a service prefers DI (e.g. the test-bridge preview). Rendering itself is pure — most
 * call sites use `renderAgentPrompt` directly, and `generate` delegates to it, so there is ONE assembly path.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Agent } from './system/agent';
import type { PromptCtx } from './system/prompt-ctx';
import { primeFragments, renderAgentPrompt } from './system/assemble';

@Injectable()
export class PromptService implements OnModuleInit {
  onModuleInit(): void {
    primeFragments(); // boot-loud validation (dup order per agent, throwing fragment, …)
  }

  /** Assemble the system prompt for `agent` against `ctx` (delegates to the pure `renderAgentPrompt`). */
  generate(agent: Agent, ctx: PromptCtx = {}): string {
    return renderAgentPrompt(agent, ctx);
  }
}
