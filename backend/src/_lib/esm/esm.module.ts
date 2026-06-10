import { Global, Module } from '@nestjs/common';

/** DI tokens for ESM-only packages (loaded lazily; see EsmModule). */
export const ANTHROPIC_AGENT_SDK = 'ANTHROPIC_AGENT_SDK';
export const OPENAI_CODEX_SDK = 'OPENAI_CODEX_SDK';

/**
 * Exposes ESM-only packages as injectable tokens so the rest of the (CommonJS) NestJS app stays CJS.
 * `eval('import("…")')` keeps TypeScript from down-compiling the dynamic `import()` to `require()`,
 * which would fail on a pure-ESM package. House pattern (rs-crm-app / cubix-infra `src/_lib/esm`).
 *
 * The worker engine adapters may instead `await import('pkg')` directly inside `run()` (the backend is
 * `module: nodenext`, which preserves dynamic import). This module is the DI-friendly alternative.
 */
@Global()
@Module({
  providers: [
    {
      provide: ANTHROPIC_AGENT_SDK,
      useFactory: async () => await eval('import("@anthropic-ai/claude-agent-sdk")'),
    },
    {
      provide: OPENAI_CODEX_SDK,
      useFactory: async () => await eval('import("@openai/codex-sdk")'),
    },
  ],
  exports: [ANTHROPIC_AGENT_SDK, OPENAI_CODEX_SDK],
})
export class EsmModule {}
