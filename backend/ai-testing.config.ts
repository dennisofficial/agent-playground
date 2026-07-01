import { defineConfig } from '@workspace/ai-testing/config';

/**
 * Config for the `@workspace/ai-testing` CLI (`pnpm eval` / `pnpm eval:check`, run from
 * `backend/`). The package imports no tracing SDK — tracing is wired here, optionally, the
 * same way the app does it (Langfuse via OTEL).
 *
 * Env: mirrors `vitest.setup.ts` layering — `.env.personal` first (git-ignored; holds the real
 * secrets like `ANTHROPIC_API_KEY`), THEN `.env.test.enc` (committed, encrypted, non-secret
 * config) overloading on top. The chain-under-test and the LLM judge both read `ANTHROPIC_API_KEY`
 * (the judge is pinned to Anthropic Haiku, so this stays a single-provider run).
 */

import { existsSync } from 'node:fs';

// Held across setup()/teardown() so spans flush before the process exits.
let tracerShutdown: (() => Promise<void>) | undefined;

export default defineConfig({
  // Runs once before any module loads.
  setup: async () => {
    const { config } = await import('@dotenvx/dotenvx');
    // Load-bearing order (see vitest.setup.ts): personal secrets first, encrypted test config
    // second with overload so the test tier wins for every key it defines.
    if (existsSync('.env.personal')) {
      config({ path: '.env.personal', logLevel: 'error', overload: true });
    }
    config({ path: '.env.test.enc', strict: true, logLevel: 'error', overload: true });

    // Opt-in Langfuse tracing: AI_TESTING_TRACING=1 + LANGFUSE_* creds present.
    if (process.env.AI_TESTING_TRACING === '1' && process.env.LANGFUSE_SECRET_KEY) {
      const { LangfuseSpanProcessor } = await import('@langfuse/otel');
      const { NodeSDK } = await import('@opentelemetry/sdk-node');
      const processor = new LangfuseSpanProcessor();
      const sdk = new NodeSDK({ spanProcessors: [processor] });
      sdk.start();
      tracerShutdown = async () => {
        await processor.forceFlush();
        await sdk.shutdown();
      };
    }
  },

  // LangChain callbacks attached to every runnable.invoke. [] = no tracing.
  tracing: async () => {
    if (!tracerShutdown) return [];
    const { LangfuseCallbackHandler } = await import('@workspace/langfuse');
    return [new LangfuseCallbackHandler({ tags: ['ai-testing'] })];
  },

  // Drain spans before exit (no-op when tracing is off).
  teardown: async () => {
    await tracerShutdown?.();
  },

  // concurrency = max in-flight cases across ALL modules. Each planner case is one Sonnet 5
  // structured call + one Haiku judge call; keep it modest — planner turns are heavier than
  // mls-studio's Haiku nodes. Raise with --concurrency once the dataset grows.
  defaults: { threshold: 0.8, concurrency: 6, failOnBelowThreshold: true },
  report: { dumpBelowThreshold: true, showConsoleLogs: true, maxDumps: 5 },
});
