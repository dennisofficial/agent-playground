import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EMessageType } from "../generated/prisma/enums.js";
import type { EngineSession, Thread } from "../generated/prisma/client.js";
import {
  promptPayload,
  renderPrompt,
  type EHarnessVariant,
} from "../domain/message.js";
import { buildSystemPrompt } from "../domain/system-prompt.js";
import { AccountVaultService } from "../auth/account-vault.service.js";
import { EngineHomeService } from "../auth/engine-home.service.js";
import { ClaudeEngineService } from "../engine/claude-engine.service.js";
import { AccountRepository } from "../store/account.repository.js";
import { MessageRepository } from "../store/message.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { TurnRepository } from "../store/turn.repository.js";
import { AccountRotatorService } from "./account-rotator.service.js";
import { AccountUsageService } from "./account-usage.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import type { ConversationStore } from "./conversation.store.js";
import { finaliseTurn } from "./turn-completion.js";
import { TurnEventApplier } from "./turn-events.js";
import { TurnLanes, type Lane } from "./turn-lanes.js";

export type RunTurnArgs = {
  thread: Thread;
  session: EngineSession;
  prompt: string;
  cwd: string;
  /**
   * Set when ATLAS is speaking rather than Dennis: the same prompt, persisted as a `harness` message
   * and delivered inside an envelope. Absent means the human typed it, and it goes in bare.
   */
  harnessVariant?: EHarnessVariant;
  /**
   * The phase's standing instructions, appended to the envelope vocabulary on this turn's system
   * prompt. Passed in rather than looked up: the runner deals in threads and sessions, and a phase
   * read on the hot path would be a database round trip per turn for a string that cannot change.
   */
  brief?: string;
};

@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);
  /** What is running where, and the per-thread write chain. See `turn-lanes.ts`. */
  private readonly lanes = new TurnLanes();
  private readonly events: TurnEventApplier;

  constructor(
    private readonly claudeEngineService: ClaudeEngineService,
    private readonly accountVaultService: AccountVaultService,
    private readonly engineHomeService: EngineHomeService,
    private readonly accountRotatorService: AccountRotatorService,
    private readonly accountUsageService: AccountUsageService,
    // Not kept as fields: these three are the applier's, handed straight to it below. Nest still
    // injects them here because that is where the container can see them.
    accountRepository: AccountRepository,
    messageRepository: MessageRepository,
    private readonly sessionRepository: SessionRepository,
    turnRepository: TurnRepository,
    private readonly stores: ConversationStoreRegistry,
  ) {
    this.events = new TurnEventApplier({
      sessionRepository,
      accountRepository,
      messageRepository,
      turnRepository,
    });
  }

  busy(threadId: string): boolean {
    return this.lanes.busy(threadId);
  }

  subscribe = (listener: () => void): (() => void) => this.lanes.subscribe(listener);

  getRunningThreadIds = (): string[] => this.lanes.getRunningThreadIds();

  run(args: RunTurnArgs): Promise<void> {
    const lane = this.lanes.for(args.thread.id);
    const seq = (lane.turnSeq += 1);
    // Started before `lane.inFlight` is reassigned, so `queueTurn` reads the PREVIOUS turn.
    const turn = this.queueTurn(lane, args, seq);
    lane.inFlight = turn;
    this.lanes.announce();
    return turn;
  }

  private async queueTurn(
    lane: Lane,
    args: RunTurnArgs,
    seq: number,
  ): Promise<void> {
    const previous = lane.inFlight;
    // A failed turn must not poison the next one; its error already reached its own caller.
    if (previous) await previous.catch(() => undefined);
    try {
      await this.execute(lane, args);
    } finally {
      // Cleared here rather than off the returned promise, so `busy` is already false by the time
      // the caller's `await` resumes. Only the LAST turn clears it — an earlier one finishing must
      // not report idle while a queued turn is still waiting to start.
      if (lane.turnSeq === seq) {
        lane.inFlight = undefined;
        lane.turn = undefined;
        this.lanes.reap(args.thread.id);
        this.lanes.announce();
      }
    }
  }

  private async execute(lane: Lane, args: RunTurnArgs): Promise<void> {
    const { thread, cwd } = args;
    const store = this.stores.for(thread.id);
    let session = args.session;

    // Rotate at a turn BOUNDARY when the active account is near its wall, so no work is lost.
    const outcome = await this.accountRotatorService.considerRotation({
      sessionId: session.id,
      accountId: session.accountId,
      engine: session.engine,
    });
    if (outcome.kind === "rotated") {
      store.notice(
        `switched to ${outcome.to.label} · ${outcome.from.label} hit its 5-hour limit`,
      );
      session = { ...session, accountId: outcome.to.id };
    }

    store.startTurn();
    // The 5-hour window is burned BY this turn, so the meters follow it rather than waiting for it.
    this.accountUsageService.track({
      accountId: session.accountId,
      threadId: thread.id,
    });
    lane.contextPercent = undefined;
    lane.usage = undefined;
    // Wall clock, and deliberately started HERE rather than from the SDK's `duration_ms`: this is
    // the number the working line counted up to, credential fetch and spawn included.
    const startedAt = new Date();
    let ok = false;
    try {
      // The payload is written first and rendered second, so the transcript records WHO spoke and
      // the model receives the envelope that says the same thing. One source, two directions.
      const payload = promptPayload({
        text: args.prompt,
        harnessVariant: args.harnessVariant,
      });
      await this.events.persist({
        store,
        threadId: thread.id,
        sessionId: session.id,
        payload,
      });

      const blob = await this.accountVaultService.freshCredential(
        session.accountId,
      );

      // Credential write and spawn happen inside one critical section — see EngineHomeService.
      const turn = await this.engineHomeService.claim(blob, (env) =>
        this.claudeEngineService.start({
          prompt: renderPrompt(payload),
          systemPrompt: buildSystemPrompt({ brief: args.brief }),
          cwd,
          model: session.model,
          resume: session.engineSessionId ?? undefined,
          env,
          onEvent: (event) => {
            this.record(lane, store, () =>
              this.events.apply({
                event,
                store,
                lane,
                threadId: thread.id,
                session,
              }),
            );
          },
        }),
      );
      lane.turn = turn;
      // The handle exists now, so anything typed during setup can go straight into the live query.
      this.lanes.flush({ lane, dequeue: (id) => store.dequeue(id) });

      const result = await turn.done;

      // The last events are still queued behind their writes; the turn is not over until they land.
      await this.lanes.settle(lane);

      if (
        result.engineSessionId &&
        result.engineSessionId !== session.engineSessionId
      ) {
        await this.sessionRepository.recordEngineSessionId({
          sessionId: session.id,
          engineSessionId: result.engineSessionId,
        });
      }
      ok = result.ok;
      this.logger.log(
        `turn finished (ok=${result.ok}, interrupted=${result.interrupted})`,
      );
    } finally {
      await finaliseTurn({
        lane,
        lanes: this.lanes,
        store,
        events: this.events,
        accountUsageService: this.accountUsageService,
        threadId: thread.id,
        session,
        startedAt,
        ok,
        onWarn: (message) => this.logger.warn(message),
      });
    }
  }

  steer(args: {
    thread: Thread;
    session: EngineSession;
    text: string;
  }): boolean {
    const { thread, session, text } = args;
    const lane = this.lanes.peek(thread.id);
    const store = this.stores.for(thread.id);
    const id = randomUUID();
    store.enqueue({ id, text });

    const deliver = (): void => {
      // Fired when the SDK actually PULLED it — the ack, not a hope.
      store.dequeue(id);
      if (lane) {
        this.record(lane, store, () =>
          this.events.persist({
            store,
            threadId: thread.id,
            sessionId: session.id,
            payload: { type: EMessageType.user, text },
          }),
        );
      }
    };

    if (lane?.turn?.steer(text, deliver)) return true;

    // The turn is still in credential setup, so there is no query to push into yet. Hold it rather
    // than dropping what the user typed — the handle flushes it the moment the query opens.
    if (lane?.inFlight) {
      this.lanes.hold({ lane, steer: { id, text, deliver } });
      return true;
    }

    store.dequeue(id);
    return false;
  }

  /** Esc with an empty composer interrupts bare; with text it is a steer-now (interrupt, then send). */
  async interrupt(threadId: string): Promise<void> {
    const lane = this.lanes.peek(threadId);
    if (!lane) return;
    this.stores.for(threadId).markInterrupting();
    await lane.turn?.interrupt();
  }

  /**
   * Queue a database write behind this lane's chain. A failure is an inline notice rather than an
   * unhandled rejection — see `TurnLanes.enqueue` for why the chain exists at all.
   */
  private record(
    lane: Lane,
    store: ConversationStore,
    work: () => Promise<void>,
  ): void {
    this.lanes.enqueue({
      lane,
      work,
      onError: (detail) => {
        this.logger.error(`failed to record a turn event: ${detail}`);
        store.notice(`could not record part of this turn · ${detail}`);
      },
    });
  }
}
