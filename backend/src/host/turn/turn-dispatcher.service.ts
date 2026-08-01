import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { InboundMessageModel } from '../../generated/prisma/models';
import {
  HostTransportService,
  type LivePointer,
  TurnStalledError,
} from '../host-transport/host-transport.service';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { TurnSpecBuilderService } from './turn-spec-builder.service';
import { TurnTranscriptService } from './turn-transcript.service';

/** How often, while a turn runs, we sweep for freshly-arrived `now` messages to steer into it. */
const FORWARD_POLL_MS = 750;

/** An inbound row awaiting consumption, paired with the instant it was handed to the engine. */
interface SentMessage {
  row: InboundMessageModel;
  sentAt: Date;
}

@Injectable()
export class TurnDispatcherService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly specBuilder: TurnSpecBuilderService,
    private readonly transport: HostTransportService,
    private readonly sandbox: SandboxService,
    private readonly inbound: InboundMessageService,
    private readonly transcript: TurnTranscriptService,
    private readonly prismaService: PrismaService,
  ) {}

  async run(jobId: string, messages: InboundMessageModel[]): Promise<void> {
    const { threadId, orgId } = messages[0];
    // The trigger batch's render position: taken BEFORE the launch so it precedes the live turn's `startedAt`
    // and therefore every block the engine streams into it — the operator's bubble always leads its own turn.
    const dispatchedAt = new Date();
    const spec = await this.specBuilder.build(jobId, messages);

    const turnId = randomUUID();
    this.logger.log(`turn ${turnId} (job ${jobId}): spec built, launching engine`);
    await this.transport.writeSpec(turnId, spec);
    await this.sandbox.launchEngineTurn(jobId, turnId);
    // Redis-backed live-turn pointer (crash-safe presence + the live SSE's stream locator). Refreshed on every
    // event below; lapses on its own if this host dies mid-turn, so the working indicator self-heals.
    const live: LivePointer = { turnId, threadId, startedAt: Date.now() };
    await this.transport.markTurnLive(jobId, live);
    this.logger.log(`turn ${turnId}: engine launched, awaiting events`);

    // Consumption model: messages sent to the SDK but not yet incorporated. Starts as this turn's trigger batch;
    // mid-turn `now` steers append to it. Each is CONSUMED (bubble written) at the next assistant boundary — the
    // moment the model's turn actually sees it — but carries the instant it was SENT as its render order, so the
    // bubble lands where the operator typed it rather than after the tokens that streamed while it waited.
    // `steered` guards against re-forwarding the same row.
    const pendingConsumption: SentMessage[] = messages.map((row) => ({ row, sentAt: dispatchedAt }));
    const steered = new Set(messages.map((m) => m.id));
    const forwardAbort = new AbortController();
    const forwarding = this.forwardMidTurn(
      jobId,
      turnId,
      steered,
      pendingConsumption,
      forwardAbort.signal,
    );

    const flushConsumption = async (): Promise<void> => {
      const batch = pendingConsumption.splice(0); // take all; anything forwarded during the awaits flushes next time
      for (const { row, sentAt } of batch) await this.inbound.consume(row, sentAt);
    };

    let sessionId: string | undefined;
    let realError: unknown;
    try {
      for await (const event of this.transport.readEvents(turnId)) {
        await this.sandbox.touch(jobId); // real engine activity (incl. heartbeat) → keep the sandbox alive
        await this.transport.markTurnLive(jobId, live); // …and keep the live-turn pointer's TTL fresh
        const type = (event as { type?: string })?.type;
        // The model produced a turn → it has now seen the pending inputs. Write their bubbles BEFORE the
        // assistant's reply so the transcript reads in order.
        if (type === 'assistant') await flushConsumption();
        const sid = (event as { session_id?: string })?.session_id;
        if (sid) sessionId = sid;
        await this.transcript.record({ jobId, threadId, orgId }, event); // persist visible output (assistant)
        if (type === 'result') break;
      }
    } catch (err) {
      if (err instanceof TurnStalledError)
        this.logger.warn(`turn ${turnId}: ${err.message} — ending turn`);
      else realError = err;
    } finally {
      forwardAbort.abort();
      await forwarding.catch(() => {});
      // Backstop: anything the model never reached still gets its bubble + CONSUMED, so nothing stays stuck PENDING
      // and re-dispatches. A failed turn thus shows the operator's message with no reply — they resend (no retry loop).
      await flushConsumption();
      await this.transport.clearTurnLive(jobId); // presence off (TTL would clear it anyway if we died first)
      await this.transport.disposeTurn(turnId); // drop the finished turn's Redis streams
    }

    if (realError) throw realError;
    if (sessionId && sessionId !== spec.sessionId) {
      await this.prismaService.thread.update({ where: { id: threadId }, data: { sessionId } });
    }
  }

  private async forwardMidTurn(
    jobId: string,
    turnId: string,
    steered: Set<string>,
    pendingConsumption: SentMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const fresh = await this.inbound.pendingNowExcluding(jobId, steered);
        for (const m of fresh) {
          steered.add(m.id);
          await this.transport.writeInput(turnId, { text: m.text, priority: 'next' });
          // Stamped at the hand-off, not at consumption, so the steer sorts among the blocks it interrupted.
          pendingConsumption.push({ row: m, sentAt: new Date() });
          this.logger.log(
            `turn ${turnId}: steered mid-turn message ${m.id} (now) into the live engine`,
          );
        }
      } catch (err) {
        // Never let the steering sweep sink the turn — the event loop is the source of truth.
        this.logger.warn(`turn ${turnId}: mid-turn forward sweep failed: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, FORWARD_POLL_MS));
    }
  }
}
