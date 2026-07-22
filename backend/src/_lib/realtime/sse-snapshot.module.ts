import { Global } from '@nestjs/common';
import { CreateModule } from '@workspace/nestjs-core';
import { SseSnapshotService } from './sse-snapshot.service';

/**
 * Exports {@link SseSnapshotService} for controllers that serve joined realtime feeds as SSE snapshots.
 * Global: the `streamList` pattern is used by controllers across nearly every feature module, so this is
 * registered once in the root module and injected everywhere without a per-module import.
 */
@Global()
@CreateModule({
  services: [SseSnapshotService],
})
export class SseSnapshotModule {}
