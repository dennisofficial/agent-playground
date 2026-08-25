import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { AgentMessage } from '../../_shared/prompt-kit/message';
import { Agent } from '../../_shared/prompt-kit/system/agent';
import { primeFragments, renderAgentPrompt } from '../../_shared/prompt-kit/system/assemble';
import type { PromptCtx } from '../../_shared/prompt-kit/system/prompt-ctx';

@Injectable()
export class PromptService implements OnModuleInit {
  onModuleInit(): void {
    primeFragments(); // boot-loud validation (dup order per agent, throwing fragment, …)
  }

  generate(agent: Agent, ctx: PromptCtx = {}): AgentMessage {
    return renderAgentPrompt(agent, ctx);
  }
}
