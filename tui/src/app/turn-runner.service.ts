import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { EMessageType } from "../generated/prisma/enums.js";
import type { EngineSession, Thread } from "../generated/prisma/client.js";
import {
  toPayload,
  type EngineEvent,
  type TurnUsage,
} from "../domain/message.js";
import { AccountVaultService } from "../auth/account-vault.service.js";
import { EngineHomeService } from "../auth/engine-home.service.js";
import {
  ClaudeEngineService,
  type RunningTurn,
} from "../engine/claude-engine.service.js";
import { AccountRepository } from "../store/account.repository.js";
import { MessageRepository } from "../store/message.repository.js";
import { SessionRepository } from "../store/session.repository.js";
import { TurnRepository } from "../store/turn.repository.js";
import { AccountRotatorService } from "./account-rotator.service.js";
import { AccountUsageService } from "./account-usage.service.js";
import { ConversationStoreRegistry } from "./conversation-store.registry.js";
import type { ConversationStore } from "./conversation.store.js";

export type RunTurnArgs = {
  thread: Thread;
  session: EngineSession;
  prompt: string;
  cwd: string;
};

type PreflightSteer = { id: string; text: string; deliver: () => void };

type Lane = {
  turnSeq: number;
  inFlight?: Promise<void>;
  chain: Promise<void>;
  preflight: PreflightSteer[];
  contextPercent?: number;
  usage?: TurnUsage;
  turn?: RunningTurn;
};

@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);
  private readonly lanes = new Map<string, Lane>();

  private snapshot: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly claudeEngineService: ClaudeEngineService,
    private readonly accountVaultService: AccountVaultService,
    private readonly engineHomeService: EngineHomeService,
    private readonly accountRotatorService: AccountRotatorService,
    private readonly accountUsageService: AccountUsageService,
    private readonly accountRepository: AccountRepository,
    private readonly messageRepository: MessageRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly turnRepository: TurnRepository,
    private readonly stores: ConversationStoreRegistry,
  ) {}

  busy(threadId: string): boolean {
    return this.lanes.get(threadId)?.inFlight !== undefined;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRunningThreadIds = (): string[] => this.snapshot;

  run(args: RunTurnArgs): Promise<void> {
    const lane = this.lane(args.thread.id);
    const seq = (lane.turnSeq += 1);
    // Started before `lane.inFlight` is reassigned, so `queueTurn` reads the PREVIOUS turn.
    const turn = this.queueTurn(lane, args, seq);
    lane.inFlight = turn;
    this.announce();
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
        this.reap(args.thread.id, lane);
        this.announce();
      }
    }
  }

  private async execute(lane: Lane, args: RunTurnArgs): Promise<void> {
    const { thread, cwd } = args;
    const store = this.stores.for(thread.id);
    let session = args.session;

    // Rotate at a turn BOUNDARY when the active account is near its wall, so no work is lost.
    const outcome = await this.accountRotatorService.considerRotation(
      session.id,
      session.accountId,
      session.engine,
    );
    if (outcome.kind === "rotated") {
      store.notice(
        `switched to ${outcome.to.label} · ${outcome.from.label} hit its 5-hour limit`,
      );
      session = { ...session, accountId: outcome.to.id };
    }

    store.startTurn();
    // The 5-hour window is burned BY this turn, so the meters follow it rather than waiting for it.
    this.accountUsageService.track(session.accountId, thread.id);
    lane.contextPercent = undefined;
    lane.usage = undefined;
    // Wall clock, and deliberately started HERE rather than from the SDK's `duration_ms`: this is
    // the number the working line counted up to, credential fetch and spawn included.
    const startedAt = new Date();
    let ok = false;
    try {
      await this.persist(store, thread.id, session.id, {
        type: EMessageType.user,
        text: args.prompt,
      });

      const blob = await this.accountVaultService.freshCredential(
        session.accountId,
      );

      // Credential write and spawn happen inside one critical section — see EngineHomeService.
      const turn = await this.engineHomeService.claim(blob, (env) =>
        this.claudeEngineService.start({
          prompt: args.prompt,
          cwd,
          model: session.model,
          resume: session.engineSessionId ?? undefined,
          env,
          onEvent: (event) => {
            this.enqueue(lane, store, () =>
              this.onEvent(event, store, lane, thread.id, session),
            );
          },
        }),
      );
      lane.turn = turn;
      // The handle exists now, so anything typed during setup can go straight into the live query.
      this.flushPreflight(lane, store);

      const result = await turn.done;

      // The last events are still queued behind their writes; the turn is not over until they land.
      await this.settle(lane);

      if (
        result.engineSessionId &&
        result.engineSessionId !== session.engineSessionId
      ) {
        await this.sessionRepository.recordEngineSessionId(
          session.id,
          result.engineSessionId,
        );
      }
      ok = result.ok;
      this.logger.log(
        `turn finished (ok=${result.ok}, interrupted=${result.interrupted})`,
      );
    } finally {
      // An expired credential throws before the engine ever starts. Without this the store stays
      // `running` forever — a spinner that never stops, and a composer that steers into nothing.
      await this.settle(lane);
      this.dropPreflight(lane, store);

      const durationMs = Date.now() - startedAt.getTime();
      // Read through a method rather than off the lane directly: the only assignment TS can see in
      // this function is the `undefined` reset above — the real one happens inside the event
      // callback — so a direct read narrows to `never`.
      const usage = this.takeUsage(lane);
      // Real counts if the engine reported any; otherwise the store keeps showing its estimate and
      // the row records the duration with zero tokens. An estimate is fine on screen and wrong in a
      // ledger — a number read back tomorrow should be one the engine actually said.
      store.endTurn(
        usage ? { durationMs, outputTokens: usage.outputTokens } : undefined,
      );
      // The turn's last tokens land after it ends, so this is the reading worth keeping.
      this.accountUsageService.stopTracking(session.accountId, thread.id);

      await this.turnRepository
        .record({
          threadId: thread.id,
          sessionId: session.id,
          startedAt,
          durationMs,
          ok,
          ...(usage === undefined ? {} : { usage }),
        })
        .catch((error: unknown) =>
          this.logger.warn(`could not store turn: ${String(error)}`),
        );

      if (lane.contextPercent !== undefined) {
        await this.sessionRepository
          .recordContextPercent(session.id, lane.contextPercent)
          .catch((error: unknown) =>
            this.logger.warn(`could not store ctx: ${String(error)}`),
          );
      }
    }
  }

  steer(thread: Thread, session: EngineSession, text: string): boolean {
    const lane = this.lanes.get(thread.id);
    const store = this.stores.for(thread.id);
    const id = randomUUID();
    store.enqueue({ id, text });

    const deliver = (): void => {
      // Fired when the SDK actually PULLED it — the ack, not a hope.
      store.dequeue(id);
      if (lane) {
        this.enqueue(lane, store, () =>
          this.persist(store, thread.id, session.id, {
            type: EMessageType.user,
            text,
          }),
        );
      }
    };

    if (lane?.turn?.steer(text, deliver)) return true;

    // The turn is still in credential setup, so there is no query to push into yet. Hold it rather
    // than dropping what the user typed — the handle flushes it the moment the query opens.
    if (lane?.inFlight) {
      lane.preflight.push({ id, text, deliver });
      return true;
    }

    store.dequeue(id);
    return false;
  }

  /** Esc with an empty composer interrupts bare; with text it is a steer-now (interrupt, then send). */
  async interrupt(threadId: string): Promise<void> {
    const lane = this.lanes.get(threadId);
    if (!lane) return;
    this.stores.for(threadId).markInterrupting();
    await lane.turn?.interrupt();
  }

  private lane(threadId: string): Lane {
    const existing = this.lanes.get(threadId);
    if (existing) return existing;
    const lane: Lane = { turnSeq: 0, chain: Promise.resolve(), preflight: [] };
    this.lanes.set(threadId, lane);
    return lane;
  }

  /** Claims the finished turn's usage and clears it, so the next turn cannot inherit it. */
  private takeUsage(lane: Lane): TurnUsage | undefined {
    const usage = lane.usage;
    lane.usage = undefined;
    return usage;
  }

  /** An idle lane is just bookkeeping — dropping it keeps the map the size of what is running. */
  private reap(threadId: string, lane: Lane): void {
    if (lane.inFlight === undefined && lane.preflight.length === 0)
      this.lanes.delete(threadId);
  }

  private announce(): void {
    const ids = [...this.lanes.entries()]
      .filter(([, lane]) => lane.inFlight !== undefined)
      .map(([threadId]) => threadId)
      .sort();
    const unchanged =
      ids.length === this.snapshot.length &&
      ids.every((id, index) => id === this.snapshot[index]);
    if (unchanged) return;
    this.snapshot = ids;
    for (const listener of this.listeners) listener();
  }

  /** The query is live — hand it everything typed while it was being set up. */
  private flushPreflight(lane: Lane, store: ConversationStore): void {
    const held = lane.preflight;
    lane.preflight = [];
    for (const steer of held) {
      if (!lane.turn?.steer(steer.text, steer.deliver)) store.dequeue(steer.id);
    }
  }

  /** The turn died before the query opened; nothing will ever pull these. No ghost entries. */
  private dropPreflight(lane: Lane, store: ConversationStore): void {
    for (const steer of lane.preflight) store.dequeue(steer.id);
    lane.preflight = [];
  }

  /**
   * The engine emits events synchronously, but handling one means writing to the database. Running
   * those handlers concurrently raced two appends for the same thread ordinal — which is UNIQUE, so
   * one write was rejected, and being fire-and-forget it took the process down with it as an
   * unhandled rejection. One chain PER THREAD: in order, one at a time, and a failure is an inline
   * notice. Two threads have two chains, which is exactly right — their ordinals are independent.
   *
   * An assistant frame carrying text AND a tool_use — the commonest frame there is — emits two
   * persisting events in the same tick, so this is the normal path, not an edge case.
   */
  private enqueue(
    lane: Lane,
    store: ConversationStore,
    work: () => Promise<void>,
  ): void {
    lane.chain = lane.chain.then(work).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`failed to record a turn event: ${detail}`);
      store.notice(`could not record part of this turn · ${detail}`);
    });
  }

  private async settle(lane: Lane): Promise<void> {
    await lane.chain;
  }

  private async onEvent(
    event: EngineEvent,
    store: ConversationStore,
    lane: Lane,
    threadId: string,
    session: EngineSession,
  ): Promise<void> {
    switch (event.kind) {
      case "text_delta":
        return store.appendDelta("text", event.text);
      case "thinking_delta":
        return store.appendDelta("thinking", event.text);

      case "session":
        if (event.engineSessionId !== session.engineSessionId) {
          await this.sessionRepository.recordEngineSessionId(
            session.id,
            event.engineSessionId,
          );
        }
        return;

      case "tool_call":
        store.startTool({
          toolUseId: event.toolUseId,
          name: event.name,
          target: event.target,
          startedAt: Date.now(),
          lines: [],
        });
        await this.persistEvent(event, store, threadId, session.id);
        return;

      case "tool_result":
        store.endTool();
        await this.persistEvent(event, store, threadId, session.id);
        return;

      case "text":
      case "thinking":
      case "error":
        await this.persistEvent(event, store, threadId, session.id);
        return;

      case "usage": {
        // A subagent's window is a SEPARATE context. Letting one move the meter made `ctx` jump
        // between whichever agent spoke last — a real tape has 136 subagent frames reading anywhere
        // from 11k to 122k tokens, interleaved with the main thread's.
        if (event.parentToolUseId) return;
        const percent = Math.round(
          (event.contextTokens / event.contextLimit) * 100,
        );
        lane.contextPercent = percent;
        store.setContextPercent(percent);
        return;
      }

      case "rate_limit": {
        store.setUsage(event.window, {
          utilization: event.utilization,
          resetsAt: event.resetsAt ?? null,
        });
        await this.accountRepository.recordUsage(session.accountId, {
          window: event.window,
          utilization: event.utilization,
          resetsAt: event.resetsAt,
        });
        return;
      }

      case "result":
        // The only frame carrying real token counts. It is not persisted here — the row is written
        // once, at the end of the turn, where the duration is also known.
        if (event.usage) lane.usage = event.usage;
        return;

      case "input_ack":
        return;
    }
  }

  private async persistEvent(
    event: EngineEvent,
    store: ConversationStore,
    threadId: string,
    sessionId: string,
  ): Promise<void> {
    const payload = toPayload(event);
    if (payload) await this.persist(store, threadId, sessionId, payload);
  }

  private async persist(
    store: ConversationStore,
    threadId: string,
    sessionId: string,
    payload: Parameters<MessageRepository["append"]>[0]["payload"],
  ): Promise<void> {
    const message = await this.messageRepository.append({
      threadId,
      sessionId,
      payload,
    });
    store.commit(message);
  }
}
