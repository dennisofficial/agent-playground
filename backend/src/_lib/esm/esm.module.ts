import { Global, Module } from '@nestjs/common';

/** DI tokens for ESM-only packages (loaded lazily; see EsmModule). */
export const ANTHROPIC_AGENT_SDK = 'ANTHROPIC_AGENT_SDK';
export const OPENAI_CODEX_SDK = 'OPENAI_CODEX_SDK';

/**
 * Exposes ESM-only packages as injectable tokens so the rest of the (CommonJS) NestJS app stays CJS.
 * The backend compiles with `module: nodenext`, which PRESERVES dynamic `import()` in CJS emit (it
 * is not down-compiled to `require()`), so a plain dynamic import loads the pure-ESM packages fine.
 * The older `eval('import(…)')` form of this house pattern breaks under vitest's module runner
 * ("a dynamic import callback was not specified"); plain `import()` works in both runtimes.
 */
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
