import { hasCanary } from "../domain/canary.js";
import {
  toPayload,
  type EngineEvent,
  type TurnUsage,
} from "../domain/message.js";
import type { EngineSession } from "../generated/prisma/client.js";
import type { ContextPressureService } from "./context-pressure.service.js";
import type { AccountRepository } from "../store/account.repository.js";
import type { MessageRepository } from "../store/message.repository.js";
import type { SessionRepository } from "../store/session.repository.js";
import type { TurnRepository } from "../store/turn.repository.js";
import type { ConversationStore } from "./conversation.store.js";
import type { RunningSession } from "./session-rotation.js";
import type { Lane } from "./turn-lanes.js";

type Payload = Parameters<MessageRepository["append"]>[0]["payload"];

/**
 * One engine event → the store, the database, or the lane. This is the table the delta-vs-
 * authoritative rule is actually written in: deltas reach the live tail and nothing else, blocks are
 * persisted, and readings land wherever they are read back from.
 *
 * Separated from the turn lifecycle so the two can be read apart — the runner answers "what happens
 * across a turn", this answers "what does this frame mean". Constructed by the runner from the
 * repositories it already injects rather than being a provider of its own, because a second consumer
 * of this would be writing into someone else's transcript.
 */
export class TurnEventApplier {
  constructor(
    private readonly repositories: {
      sessionRepository: SessionRepository;
      accountRepository: AccountRepository;
      messageRepository: MessageRepository;
      turnRepository: TurnRepository;
    },
    /**
     * The two context instruments. Passed in beside the repositories because the readings arrive as
     * ordinary frames on this stream — occupancy on an assistant frame's usage, the canary on the
     * first prose block — and a second reader of the same events would be a second answer.
     */
    private readonly contextPressureService: ContextPressureService,
  ) {}

  /**
   * The ledger row for a finished turn, plus the context reading worth reopening the thread with.
   *
   * Both are best-effort: the turn HAPPENED, and failing to write a record of it must not turn a
   * successful turn into a thrown one. `onWarn` carries the failure to the log without giving this
   * module a logger of its own.
   */
  async recordCompletion(args: {
    threadId: string;
    sessionId: string;
    startedAt: Date;
    durationMs: number;
    ok: boolean;
    usage: TurnUsage | undefined;
    contextPercent: number | undefined;
    onWarn: (message: string) => void;
  }): Promise<void> {
    await this.repositories.turnRepository
      .record({
        threadId: args.threadId,
        sessionId: args.sessionId,
        startedAt: args.startedAt,
        durationMs: args.durationMs,
        ok: args.ok,
        ...(args.usage === undefined ? {} : { usage: args.usage }),
      })
      .catch((error: unknown) =>
        args.onWarn(`could not store turn: ${String(error)}`),
      );

    if (args.contextPercent === undefined) return;
    await this.repositories.sessionRepository
      .recordContextPercent(args.sessionId, args.contextPercent)
      .catch((error: unknown) =>
        args.onWarn(`could not store ctx: ${String(error)}`),
      );
  }

  async apply(args: {
    event: EngineEvent;
    store: ConversationStore;
    lane: Lane;
    threadId: string;
    /** A rate-limit frame is written onto the account that earned it, so the account is required. */
    session: RunningSession;
  }): Promise<void> {
    const { event, store, lane, threadId, session } = args;
    switch (event.kind) {
      case "text_delta":
        return store.appendDelta("text", event.text);
      case "thinking_delta":
        return store.appendDelta("thinking", event.text);

      case "session":
        if (event.engineSessionId !== session.engineSessionId) {
          await this.repositories.sessionRepository.recordEngineSessionId({
            sessionId: session.id,
            engineSessionId: event.engineSessionId,
          });
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
        await this.persistEvent({ event, store, threadId, sessionId: session.id });
        return;

      case "tool_result":
        store.endTool();
        await this.persistEvent({ event, store, threadId, sessionId: session.id });
        return;

      case "text":
        // The canary is read HERE, off the text on its way into the store, because the render layer
        // strips a leading glyph from every prose surface — a watcher pointed at what is displayed
        // would see 100% absence and call every session dead. Only the turn's FIRST block counts:
        // the instruction is about how a message OPENS, and blocks after the first do not open one.
        lane.canary ??= hasCanary(event.text);
        await this.persistEvent({ event, store, threadId, sessionId: session.id });
        return;

      case "thinking":
      case "error":
        await this.persistEvent({ event, store, threadId, sessionId: session.id });
        return;

      case "usage": {
        // A subagent's window is a SEPARATE context. Letting one move the meter made `ctx` jump
        // between whichever agent spoke last — a real tape has 136 subagent frames reading anywhere
        // from 11k to 122k tokens, interleaved with the main thread's.
        if (event.parentToolUseId) return;
        const reading = this.contextPressureService.observe({
          session,
          contextTokens: event.contextTokens,
          contextLimit: event.contextLimit,
        });
        lane.contextPercent = reading.percent;
        // The tokens, not just the percentage: the nudge quotes the count and the budget back, and
        // the tool-boundary decision is made against them rather than against a rounded ratio.
        lane.contextTokens = event.contextTokens;
        lane.contextLimit = event.contextLimit;
        store.setContextPercent(reading);
        return;
      }

      case "rate_limit": {
        store.setUsage(event.window, {
          utilization: event.utilization,
          resetsAt: event.resetsAt ?? null,
        });
        await this.repositories.accountRepository.recordUsage(session.accountId, {
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

  /** Write it, then hand the STORED row to the store: one id, one ordinal, one source of truth. */
  async persist(args: {
    store: ConversationStore;
    threadId: string;
    sessionId: string;
    payload: Payload;
  }): Promise<void> {
    const message = await this.repositories.messageRepository.append({
      threadId: args.threadId,
      sessionId: args.sessionId,
      payload: args.payload,
    });
    args.store.commit(message);
  }

  private async persistEvent(args: {
    event: EngineEvent;
    store: ConversationStore;
    threadId: string;
    sessionId: string;
  }): Promise<void> {
    const payload = toPayload(args.event);
    if (payload) await this.persist({ ...args, payload });
  }
}
