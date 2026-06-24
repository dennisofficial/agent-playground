import { Global, Module } from '@nestjs/common';

/**
 * DI tokens for the ESM-only engine SDKs, loaded lazily. Atlas's OWN copy of the v1 `_lib/esm`
 * pattern (the clean room can't import v1's module). The backend compiles with `module: nodenext`,
 * which PRESERVES dynamic `import()` in CJS emit (it is NOT down-compiled to `require()`), so a plain
 * dynamic import loads these pure-ESM packages in both Nest and vitest's module runner.
 */
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
