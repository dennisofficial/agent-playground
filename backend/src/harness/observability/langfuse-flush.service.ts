import { flushTracing } from '@core/tracing';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

/**
 * Drains buffered Langfuse spans on shutdown. The OTEL SDK itself is started as a
 * side-effect of `import '@core/tracing'` at the top of each `main.ts` (before Nest
 * exists); this service only hooks the Nest lifecycle so `app.close()` /
 * `enableShutdownHooks()` triggers a final flush. No-op when tracing is disabled.
 *
 * Lives in `ObservabilityModule`, imported by `HarnessModule`, so every composer of the
 * harness (tui, slack-app, api) gets the flush hook with no per-app wiring.
 */
@Injectable()
export class LangfuseFlushService implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushTracing();
  }
}
