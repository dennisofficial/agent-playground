import { Thread } from '@lib/database/entities/thread.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { randomUUID } from 'node:crypto';
import type { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import { HostTransportService, TurnStalledError } from '../host-transport/host-transport.service';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';

/** How often, while a turn runs, we sweep for freshly-arrived messages to steer into it. */
const FORWARD_POLL_MS = 750;

@Injectable()
export class TurnDispatcherService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly specBuilder: TurnSpecBuilderService,
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxService,
    private readonly inbound: InboundMessageService,
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

    // Steer messages that arrive WHILE this turn runs into the live engine, rather than waiting for it to end. The
    // turn's own trigger batch is excluded (it's this turn's prompt); the processor marks it delivered afterward.
    const steered = new Set(messages.map((m) => m.id));
    const forwardAbort = new AbortController();
    const forwarding = this.forwardMidTurn(jobId, turnId, steered, forwardAbort.signal);

    let sessionId: string | undefined;
    let eventCount = 0;
    try {
      for await (const event of this.transport.readEvents(turnId)) {
        eventCount++;
        await this.sandbox.touch(jobId); // real engine activity (incl. heartbeat) → keep the sandbox alive
        const sid = (event as { session_id?: string })?.session_id;
        if (sid) sessionId = sid;
        // TODO(jobs): route `event` into the job's realtime feed (filtering out `heartbeat`).
        if ((event as { type?: string })?.type === 'result') break;
      }
      this.logger.log(`turn ${turnId}: event stream ended after ${eventCount} event(s)`);
    } catch (err) {
      if (!(err instanceof TurnStalledError)) throw err;
      // A dead/wedged engine — end the turn instead of hanging forever. The trigger batch is still marked delivered
      // by the caller (no auto-retry loop); the operator can resend. A richer failure surface is future work.
      this.logger.warn(`turn ${turnId}: ${err.message} — ending turn`);
    } finally {
      forwardAbort.abort();
      await forwarding.catch(() => {});
    }

    if (sessionId && sessionId !== spec.sessionId) {
      await this.db.unsafe(Thread).update({ id: threadId }, { sessionId });
    }
  }

  private async forwardMidTurn(
    jobId: string,
    turnId: string,
    steered: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const fresh = await this.inbound.pendingExcluding(jobId, steered);
        for (const m of fresh) {
          steered.add(m.id);
          await this.transport.writeInput(turnId, m.text);
          await this.inbound.markDelivered([m.id]);
          this.logger.log(`turn ${turnId}: steered mid-turn message ${m.id} into the live engine`);
        }
      } catch (err) {
        // Never let the steering sweep sink the turn — the event loop is the source of truth.
        this.logger.warn(`turn ${turnId}: mid-turn forward sweep failed: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, FORWARD_POLL_MS));
    }
  }
}
