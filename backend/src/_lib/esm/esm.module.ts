import { Global, Module } from '@nestjs/common';

export const ANTHROPIC_AGENT_SDK = Symbol('ANTHROPIC_AGENT_SDK');
export const OPENAI_CODEX_SDK = Symbol('OPENAI_CODEX_SDK');

@Global()
@Module({
  providers: [
    {
      provide: ANTHROPIC_AGENT_SDK,
      useFactory: () => import('@anthropic-ai/claude-agent-sdk'),
    },
    {
      provide: OPENAI_CODEX_SDK,
      useFactory: () => import('@openai/codex-sdk'),
    },
  ],
  exports: [ANTHROPIC_AGENT_SDK, OPENAI_CODEX_SDK],
})
export class EsmModule {}
