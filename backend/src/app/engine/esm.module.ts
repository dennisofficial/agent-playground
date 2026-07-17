import { Global, Module } from '@nestjs/common';

export const ANTHROPIC_SDK = Symbol('ANTHROPIC_SDK');
export const CODEX_SDK = Symbol('CODEX_SDK');

@Global()
@Module({
  providers: [
    {
      provide: ANTHROPIC_SDK,
      useFactory: () => import('@anthropic-ai/claude-agent-sdk'),
    },
    {
      provide: CODEX_SDK,
      useFactory: () => import('@openai/codex-sdk'),
    },
  ],
  exports: [ANTHROPIC_SDK, CODEX_SDK],
})
export class EngineEsmModule {}
