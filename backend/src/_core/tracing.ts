import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

/**
 * Langfuse OpenTelemetry bootstrap. Imported as the FIRST side-effect line of every
 * entrypoint's `main.ts` so the span processor is running before any LangChain run
 * (and its callbacks) can emit a span.
 *
 * Gated on credentials: the harness boots in "pending-keys" mode (no LLM/observability
 * keys), so tracing self-disables when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are
 * absent rather than spamming export errors. dotenvx has already injected env into
 * `process.env` by the time this module loads, so reading it directly (before Nest's
 * EnvService exists) is correct. `LANGFUSE_BASE_URL` and `LANGFUSE_TRACING_ENVIRONMENT`
 * are read automatically by the processor from the environment.
 */
export const langfuseProcessor = new LangfuseSpanProcessor();

export const langfuseSdk = new NodeSDK({ spanProcessors: [langfuseProcessor] });

langfuseSdk?.start();

let flushed = false;

/**
 * Drain buffered spans and release the SDK. Idempotent — called once from the Nest
 * shutdown hook (LangfuseFlushService); a no-op when tracing is disabled.
 */
export async function flushTracing(): Promise<void> {
  if (flushed) return;
  flushed = true;
  await langfuseProcessor?.forceFlush();
  await langfuseProcessor?.shutdown();
  await langfuseSdk?.shutdown();
}
