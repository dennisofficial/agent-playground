import { hasCanary } from "../domain/canary.js";
import { isDelegateEvent } from "../domain/delegates.js";
import {
  toPayload,
  type EngineEvent,
  type TurnUsage,
} from "../domain/message.js";
import { addTurnUsage } from "../domain/turn-usage.js";
import { mcpServerNotices } from "../domain/mcp-servers.js";
import { EMessageType } from "../generated/prisma/enums.js";
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

/** The `noticeOnce` key family for "fast mode is not serving", one key per reason. */

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
    contextTokens: number | undefined;
    contextLimit: number | undefined;
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

    // Both or neither: they arrive on the same frame, and a token count without the window it was
    // measured against cannot be coloured or drawn when the thread is reopened.
    if (args.contextTokens === undefined || args.contextLimit === undefined) return;
    await this.repositories.sessionRepository
      .recordContextUsage(args.sessionId, {
        contextTokens: args.contextTokens,
        contextLimit: args.contextLimit,
      })
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

    // Taken FIRST and by one predicate, because "whose frame is this" has to be answered before "what
    // does this frame mean". A delegate's tool call is a real tool call — the switch below would
    // happily start a spinner for it and write it into this thread's transcript, which is precisely the
    // bug this routing exists to make impossible. See `domain/delegates.ts`.
    if (isDelegateEvent(event)) {
      store.observeDelegate(event);
      return;
    }

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
        // An MCP server that will not serve is otherwise perfectly silent — no tool call fails,
        // because the tool was never there to call. `noticeOnce`, keyed by server AND status, so a
        // repository with one broken server costs one row per job rather than one per turn.
        for (const notice of mcpServerNotices(event.mcpServers ?? [])) {
          store.noticeOnce(notice.key, notice.text);
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
        // Only THIS thread's readings reach here — a delegate's window is a separate context and its
        // frames were routed away above. Letting one move the meter made `ctx` jump between whichever
        // agent spoke last: a real tape has 136 subagent frames reading anywhere from 11k to 122k
        // tokens, interleaved with the main thread's.
        const reading = this.contextPressureService.observe({
          session,
          contextTokens: event.contextTokens,
          contextLimit: event.contextLimit,
        });
        // The tokens and the window, not the reading: the nudge quotes the count and the budget
        // back, and the tool-boundary decision is made against them rather than a rounded ratio.
        lane.contextTokens = event.contextTokens;
        lane.contextLimit = event.contextLimit;
        store.setContextReading(reading);
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

      case "extra_usage": {
        // A refusal is written down; a success is NOT. `extraUsageEnabled: true` is the usage
        // endpoint's to say — it polls the provisioning directly — and inferring it from a turn
        // that merely went through would overwrite a real `false` with a guess. A refusal is the
        // other way round: it is first-hand, and recording it stops rotation choosing this wallet
        // again on the next turn boundary.
        if (event.disabledReason !== undefined || event.utilization !== undefined) {
          await this.repositories.accountRepository.recordExtraUsage(session.accountId, {
            ...(event.disabledReason === undefined ? {} : { enabled: false }),
            ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
          });
        }
        // Written down, never announced. Both halves of this used to draw a transcript row — "this
        // turn is billed to extra usage", and the refusal beside it — and a row per standing
        // condition is what turned a working transcript into a column of harness commentary. The
        // account row is the record, and the accounts page (ctrl+a) is where it is read.
        return;
      }

      // Fast mode reports its state on every turn of every session, and Atlas used to relay the
      // refusals. Whether the paying account HAS fast mode is a fact about the account, and the
      // accounts page holds it; a per-turn row about it is commentary.
      case "fast_mode":
        return;

      case "result":
        // The only frame carrying real token counts. It is not persisted here — the row is written
        // once, at the end of the turn, where the duration is also known.
        //
        // ACCUMULATED, not assigned. A held turn produces one result per wake-up and each is scoped
        // to its own request cycle, so the last one is a fraction of the bill rather than the bill.
        // See `domain/turn-usage.ts`.
        lane.usage = addTurnUsage({ total: lane.usage, next: event.usage });
        return;

      case "input_ack": {
        // The model has read a steer, and this is the first moment anything in the process knows it.
        //
        // Unknown ids are the common case and are dropped in silence: the CLI replays EVERY user
        // message it takes, so this fires for the turn's own prompt and for the engine's background
        // nudges too. Only what is in the queue is something a human is watching.
        const steer = store.findQueued(event.id);
        if (!steer) return;
        // On the write chain like every other frame, which is what puts the row in its true place —
        // after the tool result the model read it beside, rather than at the top of the turn where
        // the old pull-time write used to strand it.
        //
        // It leaves the queue as part of the commit rather than before it: one patch, so the message
        // MOVES from under the working line into the transcript instead of blinking out of one list
        // and into the other. A failed write leaves it queued, where the turn's end will report it.
        await this.persist({
          store,
          threadId,
          sessionId: session.id,
          payload: { type: EMessageType.user, text: steer.text },
          dequeueId: event.id,
        });
        return;
      }
    }
  }

  /** Write it, then hand the STORED row to the store: one id, one ordinal, one source of truth. */
  async persist(args: {
    store: ConversationStore;
    threadId: string;
    sessionId: string;
    payload: Payload;
    /** A queued steer this row IS, retired in the same patch that commits it. See `commit`. */
    dequeueId?: string;
  }): Promise<void> {
    const message = await this.repositories.messageRepository.append({
      threadId: args.threadId,
      sessionId: args.sessionId,
      payload: args.payload,
    });
    args.store.commit(message, args.dequeueId);
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
