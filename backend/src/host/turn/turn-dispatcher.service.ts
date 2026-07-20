import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TurnSpec } from '../../_shared/engine/turn-spec';
import { HostTransportService } from '../host-transport/host-transport.service';
import { SandboxRuntime } from '../sandbox/sandbox-runtime.service';

/**
 * Orchestrates one turn: publish the spec, ensure a runtime and launch the engine into it, then tail the
 * engine's events (refreshing the sandbox liveness lease off that real activity). This is the business
 * logic that sits ABOVE {@link HostTransportService} — the transport is a dumb Redis messenger, this owns
 * the turnId, the sandbox handshake, and the event loop.
 *
 * STUB this pass: no trigger wires jobs → turns yet, and events are only used to keep the lease warm.
 * Routing events into the job realtime feed lands with the jobs-execution pass.
 */
@Injectable()
export class TurnDispatcherService {
  constructor(
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxRuntime,
  ) {}

  async run(jobId: string, spec: TurnSpec): Promise<void> {
    const turnId = randomUUID();
    await this.transport.writeSpec(turnId, spec);
    await this.sandbox.launchEngineTurn(jobId, turnId);

    for await (const event of this.transport.readEvents(turnId)) {
      await this.sandbox.touch(jobId); // real engine activity → keep the sandbox alive
      // TODO(jobs): route `event` into the job's realtime feed.
      if ((event as { type?: string })?.type === 'result') break;
    }
  }
}
