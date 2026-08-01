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

/**
 * An inbound row handed to the engine but not yet incorporated by the model.
 *
 * `messagesAtHandoff` is how many assistant messages the turn had opened when this row was handed over. The
 * model can only have seen it once a LATER message opens, so `messagesOpened > messagesAtHandoff` is the
 * proof it was read — a counter rather than a timestamp, because a steer forwarded in the same millisecond
 * as a message boundary must not be mistaken for one the model had already taken in.
 *
 * `trigger` rows opened the turn (they sit in the spec's prompt); everything else is a mid-turn steer, which
 * the SDK only injects at a tool boundary — so a steer may still be unread when the turn ends, and the two
 * are handled differently there.
 */
interface SentMessage {
  row: InboundMessageModel;
  orderAt: Date | null;
  messagesAtHandoff: number;
  trigger: boolean;
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

    // Consumption model: messages handed to the SDK but not yet incorporated. Starts as this turn's trigger
    // batch; mid-turn steers append to it. A row is CONSUMED (bubble written) once the model has *begun* an
    // assistant message after receiving it — see `messageStartedAt`. `steered` guards re-forwarding.
    const pendingConsumption: SentMessage[] = messages.map((row) => ({
      row,
      orderAt: dispatchedAt,
      messagesAtHandoff: 0,
      trigger: true,
    }));

    // How many assistant messages this turn has opened so far (counted off `message_start`).
    let messagesOpened = 0;

    const steered = new Set(messages.map((m) => m.id));
    const forwardAbort = new AbortController();
    const forwarding = this.forwardMidTurn(
      jobId,
      turnId,
      steered,
      // A steer takes its natural `created_at` position (`orderAt` null) — the boundary where the model
      // actually picked it up, i.e. after the output it was queued behind.
      (row) =>
        pendingConsumption.push({
          row,
          orderAt: null,
          messagesAtHandoff: messagesOpened,
          trigger: false,
        }),
      forwardAbort.signal,
    );

    /**
     * Consume every row the model has demonstrably read: those handed over before the message that has just
     * been produced was opened. A trigger row is at handoff-count 0, so it always flushes at the turn's first
     * boundary; a steer only flushes once the SDK has injected it and the model has opened a fresh message.
     */
    const flushRead = async (): Promise<void> => {
      const read = pendingConsumption.filter((m) => messagesOpened > m.messagesAtHandoff);
      for (const m of read) pendingConsumption.splice(pendingConsumption.indexOf(m), 1);
      for (const { row, orderAt } of read) await this.inbound.consume(row, orderAt);
    };

    let sessionId: string | undefined;
    let realError: unknown;
    try {
      for await (const event of this.transport.readEvents(turnId)) {
        await this.sandbox.touch(jobId); // real engine activity (incl. heartbeat) → keep the sandbox alive
        await this.transport.markTurnLive(jobId, live); // …and keep the live-turn pointer's TTL fresh
        const type = (event as { type?: string })?.type;
        // `message_start` opens a new assistant message: everything handed over before it is what the model
        // is answering. Counted off the partial-message stream, which `includePartialMessages` gives us —
        // without it a steer delivered mid-generation would look like one the model had already read.
        if (type === 'stream_event') {
          const inner = (event as { event?: { type?: string } }).event?.type;
          if (inner === 'message_start') messagesOpened++;
        }
        // The model produced a turn → write the bubbles it has read BEFORE the reply, so the transcript reads
        // in order.
        if (type === 'assistant') await flushRead();
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
      // Turn over. Split what the model never reached:
      //
      // • Trigger rows are CONSUMED anyway. They were in the spec's prompt, so re-dispatching them would just
      //   re-run a turn that already failed once — a retry loop. The operator sees their message with no reply
      //   and resends.
      // • Steer rows stay PENDING. The SDK only injects a `next` message at a tool boundary, so a turn that
      //   answered in one stretch of prose never reached one and the text is still unread — consuming it here
      //   is what silently swallowed steers. Left pending, the dispatch processor's claim loop picks it up on
      //   its very next pass and runs it as the trigger of a fresh turn, where it lands in the prompt directly
      //   (so this cannot loop).
      for (const { row, orderAt, trigger } of pendingConsumption.splice(0)) {
        if (trigger) await this.inbound.consume(row, orderAt);
        else
          this.logger.log(
            `turn ${turnId}: steer ${row.id} never reached a tool boundary — left pending for the next turn`,
          );
      }
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
    queueForConsumption: (row: InboundMessageModel) => void,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const fresh = await this.inbound.pendingNowExcluding(jobId, steered);
        for (const m of fresh) {
          steered.add(m.id);
          // `next`, not `now`: the model finishes what it is saying and takes this at the next tool boundary.
          // `now` cuts the in-flight response off mid-sentence, which is not what sending a message mid-stream
          // should do. If the turn ends without reaching a boundary, the backstop above re-runs it as its own
          // turn rather than dropping it.
          await this.transport.writeInput(turnId, { text: m.text, priority: 'next' });
          queueForConsumption(m);
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
