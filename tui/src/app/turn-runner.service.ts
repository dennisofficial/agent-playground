import { Injectable, Logger } from "@nestjs/common";
import type { EngineSession, Thread } from "../generated/prisma/client.js";
import { promptPayload, renderPrompt } from "../domain/message.js";
import { isContextWall } from "../domain/rotation-handoff.js";
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
import { ContextPressureService } from "./context-pressure.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import type { ConversationStore } from "./conversation.store.js";
import { sessionForTurn } from "./session-rotation.js";
import { SessionManagerService } from "./session-manager.service.js";
import { finaliseTurn } from "./turn-completion.js";
import { TurnEventApplier } from "./turn-events.js";
import { TurnLanes, type Lane } from "./turn-lanes.js";
import { nudgeAtToolBoundary } from "./turn-nudge.js";
import { steerTurn } from "./turn-steering.js";

// Re-exported rather than moved outright: half this file's importers want only the argument shape,
// and every one of them already spells it `from './turn-runner.service.js'`.
import type { RunTurnArgs } from "./turn-args.js";
export type { RunTurnArgs };

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
    // The runner owns the ONE session event it can observe first-hand: the context wall, which
    // arrives as a failed turn and nowhere else. It still knows nothing about phases or tools — the
    // successor inherits this turn's `brief`, `tools` and `cwd` unchanged.
    private readonly sessionManagerService: SessionManagerService,
    // Held only to pass on: the readings arrive as frames on this turn's stream, and the decision of
    // what to do about them lives in `turn-nudge.ts`. The runner never learns what a budget is.
    private readonly contextPressureService: ContextPressureService,
  ) {
    this.events = new TurnEventApplier(
      {
        sessionRepository,
        accountRepository,
        messageRepository,
        turnRepository,
      },
      contextPressureService,
    );
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
    // Which session and which account this turn actually runs on: both can have moved since the
    // caller looked, and both move only at a turn boundary. See `session-rotation.ts`.
    const session = await sessionForTurn({
      sessionRepository: this.sessionRepository,
      accountRotatorService: this.accountRotatorService,
      store,
      threadId: thread.id,
      session: args.session,
    });
    // A turn that fails because the transcript itself no longer fits. Collected as it streams
    // because the engine reports it as an ordinary error event, and acted on in the `finally`.
    let wall = false;

    store.startTurn();
    // The 5-hour window is burned BY this turn, so the meters follow it rather than waiting for it.
    this.accountUsageService.track({
      accountId: session.accountId,
      threadId: thread.id,
    });
    lane.contextPercent = undefined;
    lane.contextTokens = undefined;
    lane.canary = undefined;
    lane.usage = undefined;
    // The nudge cadence escalates across turns and never within one, so the counter moves here.
    this.contextPressureService.startTurn(session.id);
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
        attachments: args.attachments,
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

      // Credential write and spawn happen inside one critical section — see EngineHomeService. The
      // account id travels with the blob so the read-back in `finaliseTurn` knows whose file it is.
      const turn = await this.engineHomeService.claim(
        { accountId: session.accountId, blob },
        (env) =>
          this.claudeEngineService.start({
            prompt: renderPrompt(payload),
            systemPrompt: buildSystemPrompt({ brief: args.brief }),
            cwd,
            model: session.model,
            resume: session.engineSessionId ?? undefined,
            env,
            tools: args.tools,
            // Atlas's one way into a running turn that costs the agent nothing: it is already
            // waiting on the tool. Whether anything is said at all is entirely `turn-nudge.ts`'s
            // decision.
            onToolBoundary: () =>
              nudgeAtToolBoundary({
                contextPressureService: this.contextPressureService,
                events: this.events,
                store,
                thread,
                session,
                lane,
                record: (work) => this.record(lane, store, work),
              }),
            onEvent: (event) => {
              if (event.kind === "error" && isContextWall(event)) wall = true;
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
        engineHomeService: this.engineHomeService,
        accountVaultService: this.accountVaultService,
        contextPressureService: this.contextPressureService,
        sessionManagerService: this.sessionManagerService,
        threadId: thread.id,
        session,
        startedAt,
        ok,
        turn: args,
        wall,
        run: (next) => void this.run(next),
        onWarn: (message) => this.logger.warn(message),
      });
    }
  }

  steer(args: {
    thread: Thread;
    session: EngineSession;
    text: string;
  }): boolean {
    const store = this.stores.for(args.thread.id);
    return steerTurn({
      lanes: this.lanes,
      lane: this.lanes.peek(args.thread.id),
      store,
      events: this.events,
      record: ({ lane, work }) => this.record(lane, store, work),
      ...args,
    });
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
