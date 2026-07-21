import { Thread } from '@lib/database/entities/thread.entity';
import { Injectable } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { randomUUID } from 'node:crypto';
import type { TurnSpec } from '../../_shared/engine/turn-spec';
import { HostTransportService } from '../host-transport/host-transport.service';
import { SandboxService } from '../sandbox/sandbox.service';

@Injectable()
export class TurnDispatcherService {
  constructor(
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxService,
    private readonly db: Db,
  ) {}

  async run(jobId: string, threadId: string, spec: TurnSpec): Promise<void> {
    const turnId = randomUUID();
    await this.transport.writeSpec(turnId, spec);
    await this.sandbox.launchEngineTurn(jobId, turnId);

    let sessionId: string | undefined;
    for await (const event of this.transport.readEvents(turnId)) {
      await this.sandbox.touch(jobId); // real engine activity → keep the sandbox alive
      const sid = (event as { session_id?: string })?.session_id;
      if (sid) sessionId = sid;
      // TODO(jobs): route `event` into the job's realtime feed.
      if ((event as { type?: string })?.type === 'result') break;
    }

    if (sessionId && sessionId !== spec.sessionId) {
      await this.db.unsafe(Thread).update({ id: threadId }, { sessionId });
    }
  }
}
