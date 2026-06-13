import { CreateModule } from '@workspace/nestjs-core';
import { LangfuseFlushService } from './langfuse-flush.service';

/** Langfuse span-flush-on-shutdown hook. The OTEL SDK is bootstrapped in `@core/tracing`
 * (side-effect import in each `main.ts`); this module just binds the Nest lifecycle. */
@CreateModule({
  services: [LangfuseFlushService],
})
export class ObservabilityModule {}
