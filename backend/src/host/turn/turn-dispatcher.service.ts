import { Thread } from '@lib/database/entities/thread.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { randomUUID } from 'node:crypto';
import type { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import { HostTransportService } from '../host-transport/host-transport.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';

@Injectable()
export class TurnDispatcherService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly specBuilder: TurnSpecBuilderService,
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxService,
    private readonly db: Db,
  ) {}

  async run(jobId: string, messages: InboundMessage[]): Promise<void> {
    const threadId = messages[0].threadId;
    const spec = await this.specBuilder.build(jobId, messages);

    const turnId = randomUUID();
    this.logger.log(`turn ${turnId} (job ${jobId}): spec built, launching engine`);
    await this.transport.writeSpec(turnId, spec);
    await this.sandbox.launchEngineTurn(jobId, turnId);
    this.logger.log(`turn ${turnId}: engine launched, awaiting events`);

    let sessionId: string | undefined;
    let eventCount = 0;
    for await (const event of this.transport.readEvents(turnId)) {
      eventCount++;
      await this.sandbox.touch(jobId); // real engine activity → keep the sandbox alive
      const sid = (event as { session_id?: string })?.session_id;
      if (sid) sessionId = sid;
      // TODO(jobs): route `event` into the job's realtime feed.
      if ((event as { type?: string })?.type === 'result') break;
    }
    this.logger.log(`turn ${turnId}: event stream ended after ${eventCount} event(s)`);

    if (sessionId && sessionId !== spec.sessionId) {
      await this.db.unsafe(Thread).update({ id: threadId }, { sessionId });
    }
  }
}
