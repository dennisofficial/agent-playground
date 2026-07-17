import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

export const langfuseProcessor = new LangfuseSpanProcessor();

export const langfuseSdk = new NodeSDK({ spanProcessors: [langfuseProcessor] });

langfuseSdk?.start();

let flushed = false;

export async function flushTracing(): Promise<void> {
  if (flushed) return;
  flushed = true;
  await langfuseProcessor?.forceFlush();
  await langfuseProcessor?.shutdown();
  await langfuseSdk?.shutdown();
}
