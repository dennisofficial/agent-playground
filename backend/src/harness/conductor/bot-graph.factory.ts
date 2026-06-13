import { EnvService } from '@core/config/env/env.service';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  Annotation,
  END,
  messagesStateReducer,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable } from '@nestjs/common';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { GateAction, MessageUsage } from '../domain/conductor-events';
import { getIdentity } from '../domain/identity';
import { flattenContent } from '../domain/text';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { GateService } from '../gate/gate.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { FetchService } from '../memory/fetch.service';
import { CHECKPOINTER } from '../memory/checkpointer.module';
import { ReconcileService } from '../memory/reconcile.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { DEFAULT_CHAT_TOOLSET } from '../tools/default-toolset';
import { ToolRegistry } from '../tools/tool.registry';
import { WorktreeService } from '../worktrees/worktree.service';
import { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import {
  GAP_THRESHOLD_DEFAULT_MS,
  buildTimeContext,
  withDividers,
} from './channel-render';

/**
 * A bot's TURN, as an explicit LangGraph state machine. One graph per bot, persisted on thread
 * `${bot.id}:${project}:root` (Postgres checkpointer). The conductor invokes it whenever the channel
 * has grown past the bot's cursor.
 *
 *   START → gate ─┬─ respond → guard ─┬─ fetch → llm ⟲ ⇄ tools ─┐
 *                 │                   └─ break ──────────────────┤
 *                 └─ acknowledge / ignore → consume ──────────────┴→ reconcile-memory ∥ reconcile-task → END
 *
 * Memory is DETERMINISTIC, not agentic: `fetch` reads the relevant facts + open tasks IN before the
 * bot thinks, and the two parallel `reconcile` nodes write memory/tasks OUT after — on EVERY path.
 * The llm keeps its memory/task tools too; reconcile is the state-aware backstop on top of them.
 *
 * THE HEART (mid-thought collaboration): the `llm` node consumes `channel.since(cursor)` at the TOP
 * of EVERY step, so a teammate's message that lands WHILE this bot is looping is folded into its
 * very next model call.
 *
 * READ-THE-ROOM (the `llm ⟲` self-loop): a final text reply is composed BLIND for one
 * model-invoke latency — a teammate answering the same broadcast can post during that window, which
 * is how four bots chorus the same news. So after `model.invoke` returns, the node synchronously
 * checks whether teammate-bot messages landed past the cursor this step consumed. If so, the reply
 * is demoted to a DRAFT (never posted, never in durable history) and the graph loops back through
 * `llm`: the teammate messages fold in via the NORMAL top-of-step read, plus a note carrying the
 * draft — post only if it still adds something, else trim or stay silent. The synchronous channel
 * makes check-then-return atomic per JS tick, so at most one bot "wins" each race round; capped at
 * MAX_REVISION_PASSES, after which the draft posts anyway (worst case = the old blind behavior).
 *
 * Cursor coordinate note: the `cursor` field rides in graph state ONLY so it threads across `llm`
 * steps within a single run. It is overwritten every invocation from the conductor's durable cursor
 * (CursorStore) passed as input. Unlike the playground (whose in-memory channel restarted at seq 0,
 * making the persisted value DEAD), the channel log + cursors are now both durable and share one
 * coordinate space — but the conductor still owns the cursor; the graph only borrows it for
 * within-run threading.
 *
 * (Ported from playground/src/bot-graph.ts.)
 */

/** What the conductor reads out of a node's streamed delta (a partial of BotState). */
export interface BotStateDelta {
  messages?: BaseMessage[];
  cursor?: number;
  decision?: GateAction;
  ackEmoji?: string;
  /** A reaction emoji to surface immediately — the gate's "seen, working" 👀 on a real respond. */
  reaction?: string;
  /** The channel-message id this turn's reaction (👀 or ack) is ON — chosen HERE in the graph so the
   * conductor can tell the surface which message to fold the reaction into. */
  reactionTargetId?: string;
  /** The pre-LLM fetch's `recalled` block — the conductor emits a `recall` event from it. */
  recalled?: string;
  /** Debug only: the soft gate's one-line rationale. Absent for hard rules. */
  reasoning?: string;
  /** Debug only: token usage for this turn's gate call. Absent for hard rules. */
  gateUsage?: { input: number; output: number };
  /** Set by the `guard` node when a no-progress loop is detected — routes to `break`. */
  loopBreak?: boolean;
  /** Debug only: the guard's one-line rationale. NOT named `reasoning` to avoid conflation with
   * the gate event the conductor emits on `delta.reasoning`. Rides in the checkpoint only. */
  guardReasoning?: string;
  /** A reply suppressed at the post seam (teammates posted mid-compose) — the conductor emits a
   * `draft` debug event from it. NEVER appears in `messages`, so the commit loop can't post it. */
  draft?: string;
  /** Token usage of the suppressed draft step — still a billed call: the conductor emits a normal
   * `usage` event from it so the per-post footer stays the true turn total. */
  draftUsage?: MessageUsage;
  /** Read-the-room revision passes taken this turn (debug only in the delta). */
  revisionPasses?: number;
}

const BotState = Annotation.Root({
  /** The bot's persisted conversation (the real, durable history). */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** Delivered-up-to seq. Overwritten from the conductor each run (see header). */
  cursor: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Forces the respond path, gate-bypassed — used for job relays (a seeded synthetic message). */
  forced: Annotation<boolean>({
    reducer: (_: boolean, b: boolean) => b ?? false,
    default: () => false,
  }),
  /** Gate verdict for this turn (drives the conditional edge out of `gate`). */
  decision: Annotation<GateAction>({
    reducer: (_: GateAction, b: GateAction) => b ?? 'ignore',
    default: () => 'ignore',
  }),
  /** Ack emoji, surfaced when the gate said acknowledge. */
  ackEmoji: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** The "seen, working" reaction the gate emits the moment it commits to a (non-forced) respond. */
  reaction: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** The channel-message id this turn's reaction is on (the gated message). */
  reactionTargetId: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: the soft gate's rationale this turn. */
  reasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: token usage for this turn's gate call. */
  gateUsage: Annotation<{ input: number; output: number } | undefined>({
    reducer: (_: unknown, b: { input: number; output: number } | undefined) =>
      b,
    default: () => undefined,
  }),
  /** The non-own batch the gate decided on — consumed by `consume` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({
    reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [],
    default: () => [],
  }),
  /** Ephemeral pre-LLM memory context (the `fetch` node's output). Re-injected each llm call like
   * the persona, NEVER written into `messages`. Overwritten on EVERY path — by `fetch` (respond)
   * and reset by `consume` (ack/ignore) — so a stale recall never survives in the checkpoint. */
  recalled: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /** `messages.length` at the start of this turn (set by `gate`), so reconcile can slice just this
   * turn's exchange out of the full persisted history. */
  turnStart: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Set by the `guard` node when a no-progress loop is detected. Routes to `break` instead of
   * `fetch`. Reset to false on every run (default) so a prior break doesn't poison the next turn. */
  loopBreak: Annotation<boolean>({
    reducer: (_: boolean, b: boolean) => b ?? false,
    default: () => false,
  }),
  /** Debug only: the guard's one-line rationale for this turn. Absent when the guard skipped or
   * when `loopBreak` is false. Rides in the checkpoint; never surfaced in the event stream. */
  guardReasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** READ-THE-ROOM: the unposted reply from a step that went stale mid-compose (a teammate posted
   * during model.invoke). Survives exactly one edge — llm → llm — where the revision note carries
   * it back to the model. NEVER enters `messages`: durable history records only what was actually
   * said. Reset explicitly by `gate` every run (Annotation defaults don't re-apply on an existing
   * thread), so a draft orphaned by a crash is dropped, never replayed. */
  draft: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Usage of the suppressed draft step (billed even though unposted). Reset with `draft`. */
  draftUsage: Annotation<MessageUsage | undefined>({
    reducer: (_: unknown, b: MessageUsage | undefined) => b,
    default: () => undefined,
  }),
  /** Revision passes taken THIS turn — bounds the read-the-room loop at MAX_REVISION_PASSES.
   * Reset explicitly by `gate` every run. */
  revisionPasses: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
});

type BotStateType = typeof BotState.State;

/** Channel message → a `Speaker: text` HumanMessage (how a bot reads what others said). */
const asInput = (m: ChannelMsg): HumanMessage =>
  new HumanMessage(`${m.author}: ${m.text}`);

// ── Read-the-room constants (exported for tests) ────────────────────────────────────────────────
/** Max revision passes per turn. Each race round at most one bot posts (the synchronous check),
 * so N contending bots converge in ≤N rounds — 2 covers a realistic pileup; at the cap the draft
 * posts anyway (it already saw the earlier rounds — worst case equals the old blind behavior). */
export const MAX_REVISION_PASSES = 2;
/** The revision instruction injected as the LAST trailing HumanMessage — strictly after both
 * cache breakpoints (volatile zone), so interpolating the draft never busts the prompt prefix. */
export const revisionNote = (draft: string): string =>
  `(Heads-up: while you were composing, the messages above arrived. You drafted the following reply but it was NOT posted:\n"""\n${draft}\n"""\nRead the new messages first. Post only if your reply still adds something beyond what teammates already said — revise it, or shorten it to a brief agreement. If it's now redundant, output NOTHING (an empty response) and stay silent.)`;

/** Token usage off a model reply (mirrors the conductor's extraction in `commit`). */
const usageOf = (m: AIMessage): MessageUsage | undefined => {
  const um = m.usage_metadata;
  if (!um) return undefined;
  return {
    input: um.input_tokens ?? 0,
    output: um.output_tokens ?? 0,
    cacheRead: um.input_token_details?.cache_read || undefined,
    cacheWrite: um.input_token_details?.cache_creation || undefined,
  };
};

/**
 * A shallow copy of `m` with a cache breakpoint on its last non-thinking content block — WITHOUT
 * mutating the original (it rides in checkpointed state, so a mutation would poison the durable
 * history). Only anchors on human/ai turns carrying cacheable text; other turns fall back to
 * system-only caching. `thinking` and `redacted_thinking` blocks are intentionally skipped when
 * searching for the anchor: Anthropic rejects `cache_control` on thinking blocks, and a
 * thinking-only assistant turn (no trailing text block) returns `m` unchanged so that turn falls
 * back to system-only caching rather than crashing the API call.
 */
const withCacheBreakpoint = (m: BaseMessage): BaseMessage => {
  const kind = m.getType();
  if (kind !== 'human' && kind !== 'ai') return m;
  const cc = { type: 'ephemeral', ttl: '1h' } as const;
  const clone = (content: unknown): BaseMessage => {
    const Ctor = m.constructor as unknown as new (
      fields: unknown,
    ) => BaseMessage;
    return new Ctor({ ...m, content });
  };
  if (typeof m.content === 'string') {
    return m.content.trim()
      ? clone([{ type: 'text', text: m.content, cache_control: cc }])
      : m;
  }
  const isThinking = (b: unknown): boolean =>
    typeof b === 'object' &&
    b !== null &&
    ((b as { type?: string }).type === 'thinking' ||
      (b as { type?: string }).type === 'redacted_thinking');
  let anchor = -1;
  for (let i = m.content.length - 1; i >= 0; i--) {
    if (!isThinking(m.content[i])) {
      anchor = i;
      break;
    }
  }
  return anchor >= 0
    ? clone(
        m.content.map((b, i) =>
          i === anchor ? { ...b, cache_control: cc } : b,
        ),
      )
    : m;
};

/**
 * SELF-HEALING GUARD: repair dangling tool calls in the durable history before every model call.
 *
 * LangGraph checkpoints after EVERY node, so an interruption between the `llm` superstep (which
 * commits an AI message WITH tool_calls) and the `tools` superstep (which commits the results) —
 * a crash, a process exit mid-turn, an aborted stream — leaves an AIMessage whose `tool_use` has
 * no `tool_result` after it. Anthropic rejects that history outright (400 INVALID_TOOL_RESULTS),
 * which would otherwise brick the thread PERMANENTLY: every retry replays the same poisoned
 * checkpoint, and the conductor's retry-cap only skips channel messages, not history.
 *
 * The repair is READ-TIME and ephemeral (like the recalled-memory block): synthetic tool_results
 * are spliced in right after any dangling tool_use for THIS call's input, never persisted — so the
 * checkpoint stays an honest record of what happened, and every future read heals the same way.
 */
const repairDanglingToolCalls = (history: BaseMessage[]): BaseMessage[] => {
  let repaired: BaseMessage[] | undefined;
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.getType() !== 'ai') continue;
    const calls = (m as AIMessage).tool_calls ?? [];
    if (calls.length === 0) continue;
    // Collect the tool_result ids in the contiguous tool-message block following this AI message.
    const answered = new Set<string>();
    let j = i + 1;
    while (j < history.length && history[j].getType() === 'tool') {
      const id = (history[j] as ToolMessage).tool_call_id;
      if (id) answered.add(id);
      j++;
    }
    const missing = calls.filter((c) => c.id && !answered.has(c.id));
    if (missing.length === 0) continue;
    repaired ??= [...history];
    // Splice synthetic results in right after the existing tool block (offset by prior splices).
    const insertAt = j + (repaired.length - history.length);
    repaired.splice(
      insertAt,
      0,
      ...missing.map(
        (c) =>
          new ToolMessage({
            tool_call_id: c.id as string,
            name: c.name,
            content:
              '(no result recorded — the turn was interrupted before this tool finished)',
          }),
      ),
    );
  }
  return repaired ?? history;
};

@Injectable()
export class BotGraphFactory {
  // One compiled graph per bot, lazy + memoized. Tenant-agnostic: the model is built per-invocation
  // inside the llm node (from the turn's credential context), so one graph serves every workspace.
  private graphs = new Map<string, ReturnType<BotGraphFactory['build']>>();
  /** Minimum gap (ms) between consecutive messages that earns a time-divider in LLM history. */
  private readonly gapThresholdMs: number;

  constructor(
    private readonly channel: ChannelService,
    private readonly channelRegistry: ChannelRegistryService,
    private readonly toolRegistry: ToolRegistry,
    private readonly gateService: GateService,
    private readonly recursionGuard: RecursionGuardService,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    private readonly worktrees: WorktreeService,
    @Inject(SESSION_REGISTRY) private readonly sessions: SessionRegistry,
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
    env: EnvService,
  ) {
    this.gapThresholdMs =
      env.get('HARNESS_TIMESTAMP_GAP_MS') ?? GAP_THRESHOLD_DEFAULT_MS;
  }

  getBotGraph(bot: EmployeeDefinition) {
    let g = this.graphs.get(bot.id);
    if (!g) {
      g = this.build(bot);
      this.graphs.set(bot.id, g);
    }
    return g;
  }

  /**
   * The conversation up to (but NOT including) `seq` in one room — the last `n` messages, oldest
   * first — for the gate to read. A generous window is what lets the gate tell "an ongoing
   * human↔teammate thread I should stay out of" from "an open question I should answer."
   */
  private historyBefore(seq: number, channelId: string, n = 16): string {
    return this.channel
      .snapshot(channelId)
      .filter((m) => m.seq < seq)
      .slice(-n)
      .map((m) => `${m.author}: ${m.text}`)
      .join('\n');
  }

  /** The room a run is bound to — set by the conductor on every invocation. */
  private channelIdOf(config: RunnableConfig): string {
    return (
      (config.configurable?.channelId as string | undefined) ??
      this.channel.surfaceId
    );
  }

  /**
   * The bot's live WORK state — its worktrees and open sessions — appended to the `recalled` block
   * each respond turn, the same way reminders are. Registry reads only (no git subprocesses): this
   * runs on every respond, so it must stay cheap; on-demand git truth lives in list_worktrees.
   * Surfacing this in-context is what lets a bot notice "project: NONE" or a forgotten session
   * without spending turns spelunking with tools.
   */
  private async workContext(bot: EmployeeDefinition): Promise<string> {
    const CAP = 10;
    const parts: string[] = [];
    const trees = this.worktrees.list({ ownerBot: bot.id });
    if (trees.length) {
      const lines = trees
        .slice(0, CAP)
        .map(
          (w) =>
            `- ${w.id} "${w.name}" — branch ${w.branch}${w.sharedBranch ? `, shared: ${w.sharedBranch}` : ''}, project: ${w.project || 'NONE (GitHub pushes will fail — flag it if a push is needed)'}`,
        )
        .join('\n');
      const more = trees.length - CAP;
      parts.push(
        `Your worktrees:\n${lines}${more > 0 ? `\n…and ${more} more (list_worktrees)` : ''}`,
      );
    }
    const open = (await this.sessions.list({ ownerBot: bot.id })).filter(
      (s) => s.status !== 'closed',
    );
    if (open.length) {
      const lines = open
        .slice(0, CAP)
        .map(
          (s) =>
            `- ${s.id} (${s.status}) in ${s.worktreeId} — "${s.task.length > 80 ? `${s.task.slice(0, 80)}…` : s.task}"`,
        )
        .join('\n');
      const more = open.length - CAP;
      parts.push(
        `Your open sessions:\n${lines}${more > 0 ? `\n…and ${more} more (list_sessions)` : ''}`,
      );
    }
    return parts.join('\n\n');
  }

  private build(bot: EmployeeDefinition) {
    const channel = this.channel;
    const allowlist = bot.tools ?? DEFAULT_CHAT_TOOLSET;
    const tools = this.toolRegistry.toStructuredTools(allowlist);
    // Turn-ending tools, derived from the allowlist's `terminal` flags (no magic-string list). Only
    // can't-fail tools should be terminal: the conductor surfaces only assistant text, never
    // tool-result content, so a swallowed failure from a fallible terminal tool would be invisible.
    const TERMINAL = this.toolRegistry.terminalToolNames(allowlist);

    /** Peek the channel (read-only — never touches messages/cursor) and pick respond/ack/ignore. */
    const gateNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      // Mark where this turn's messages begin, so the reconcile nodes can slice just this turn out
      // of the full persisted history (set on every path — reconcile runs on all of them).
      const turnStart = state.messages.length;
      // Per-turn read-the-room reset, on EVERY path: Annotation defaults don't re-apply on an
      // existing thread, and a draft orphaned by a crash mid-revision must drop, not replay.
      const rtr = {
        draft: undefined,
        draftUsage: undefined,
        revisionPasses: 0,
      };
      if (state.forced)
        return { decision: 'respond', pending: [], turnStart, ...rtr }; // job relay: skip the gate
      const channelId = this.channelIdOf(config);
      const batch = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      if (batch.length === 0)
        return { decision: 'ignore', pending: [], turnStart, ...rtr }; // nothing for me
      const latest = batch[batch.length - 1];
      const capped = !!config.configurable?.capped;
      if (capped && latest.authorBotId)
        return { decision: 'ignore', pending: batch, turnStart, ...rtr }; // loop breaker
      const room = this.channelRegistry.get(channelId);
      const d = await this.gateService.gate(bot, latest.text, {
        authorBotId: latest.authorBotId,
        authorName: latest.author,
        history: this.historyBefore(latest.seq, channelId),
        channel: room ? { kind: room.kind, name: room.displayName } : undefined,
        // The WHOLE unconsumed batch — a hail buried behind a teammate's faster reply still hard-fires.
        batch: batch.map((m) => ({ text: m.text, authorBotId: m.authorBotId })),
      });
      // reasoning + gateUsage ride the delta so the conductor can emit them (debug only).
      return {
        decision: d.action,
        ackEmoji: d.emoji,
        // Fire the transient "composing" 💭 the moment we commit to responding — surfaced before
        // fetch/LLM/tools run, and REMOVED by the conductor when the turn ends (so present =
        // composing now, gone = replied). Only on a real gated respond; the forced path returned above.
        reaction: d.action === 'respond' ? '💭' : undefined,
        reactionTargetId: latest.id,
        reasoning: d.reasoning,
        gateUsage: d.usage,
        pending: batch,
        turnStart,
        ...rtr,
      };
    };

    /** The pre-LLM read: fetch the facts + open tasks relevant to what's being said into `recalled`. */
    const fetchNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const channelId = this.channelIdOf(config);
      const fresh = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      const freshText = fresh.map((m) => `${m.author}: ${m.text}`).join('\n');
      // Enrich the retrieval query with a few lines of prior context so a THIN turn ("sounds good")
      // doesn't embed to noise. The tail is query-only — it shapes retrieval, never what's stored.
      const priorTail = fresh.length
        ? this.historyBefore(fresh[0].seq, channelId, 3)
        : '';
      const query = [priorTail, freshText].filter((s) => s.trim()).join('\n');
      // Always set recalled (to '' when empty) so a stale recall from a prior turn never lingers.
      // Memory/tasks and the live work state (worktrees + sessions) are independent reads.
      const [memory, work] = await Promise.all([
        this.fetchService.fetchContext(bot, query, getIdentity(config)),
        this.workContext(bot).catch(() => ''), // degrade like retrieval — never fail the turn
      ]);
      return {
        recalled: [memory, work].filter((s) => s.trim()).join('\n\n'),
      };
    };

    /**
     * Consume `channel.since(cursor)` at the TOP (the mid-thought injection), call the model, and
     * commit the new messages + the model's reply + the advanced cursor in ONE atomic checkpoint.
     * A throw here commits nothing, so a retry re-reads the same messages — no loss, no double.
     */
    const llmNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const channelId = this.channelIdOf(config);
      const fresh = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      const newCursor = channel.lengthOf(channelId); // own/gap messages are skipped but the cursor still moves past them
      // `injected` goes into state.messages (the durable checkpoint) — plain, no dividers.
      const injected = fresh.map(asInput);
      // Message order is chosen for PROMPT CACHING (a prefix match — any byte change invalidates
      // everything after it; render order is tools → system → messages):
      //   1. persona system prompt — frozen; the breakpoint caches bound tools + persona.
      //   2. durable history — append-only; a SECOND breakpoint rides on the last history message
      //      (cloned, never mutating the checkpointed one).
      //   3. recalled memory — VOLATILE (re-retrieved each turn), so it must come AFTER the history,
      //      never in the system block (it would bust the prefix every turn, and langchain-anthropic
      //      rejects a second SystemMessage). Re-injected each call, never persisted into `messages`.
      //   4. time context — VOLATILE (current time + gap note). Placed after recalled so it always
      //      lands outside the cached prefix. Never persisted into `messages`.
      //   5. this turn's new channel messages (with inline time-dividers for any within-batch gaps).
      const history = repairDanglingToolCalls(state.messages);
      const cachedHistory = history.length
        ? [
            ...history.slice(0, -1),
            withCacheBreakpoint(history[history.length - 1]),
          ]
        : history;
      // Peek the last consumed message to detect a gap before the fresh batch.
      const prevMsg = channel
        .snapshot(channelId)
        .filter((m) => m.seq < (fresh[0]?.seq ?? 0))
        .slice(-1)[0];
      const timeContext = buildTimeContext(
        fresh,
        prevMsg?.createdAt,
        this.gapThresholdMs,
      );
      // Build the model-only view of the fresh batch: interleave time-dividers for within-batch gaps.
      const freshForModel = withDividers(fresh, this.gapThresholdMs).map(
        (item) =>
          item.kind === 'time-divider'
            ? new HumanMessage(item.label)
            : asInput(item.msg),
      );
      const convo = [
        new SystemMessage({
          content: [
            {
              type: 'text',
              text: this.persona.chatPromptFor(bot),
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        }),
        ...cachedHistory,
        ...(state.recalled
          ? [
              new HumanMessage(
                `(Relevant memory — for your reference:\n${state.recalled})`,
              ),
            ]
          : []),
        // Time context is always injected (at minimum: current time). Sits strictly AFTER the
        // history cache breakpoint so it never invalidates the cached prefix.
        new HumanMessage(`(${timeContext})`),
        ...freshForModel,
        // READ-THE-ROOM revision pass: the unposted draft + instruction, as the LAST message —
        // the teammate messages that staled it arrived through `freshForModel` above (they sat
        // past the cursor, so the normal top-of-step read picked them up).
        ...(state.draft ? [new HumanMessage(revisionNote(state.draft))] : []),
      ];
      // Built per-invocation (not at graph-build) so it reads the CURRENT turn's tenant key from
      // the credential context — one compiled graph per bot serves every workspace.
      const model = this.models.buildModel().bindTools(tools);
      const ai = await model.invoke(convo, config);
      const aiText = flattenContent(ai.content).trim();
      const hasToolCalls = ((ai as AIMessage).tool_calls?.length ?? 0) > 0;
      // READ-THE-ROOM check: synchronous (same JS tick as the return below — the in-memory channel
      // is synchronous, so nothing interleaves between this read and the checkpoint write request).
      // Only a FINAL text post is gated: a tool-call step must enter history intact (a tool_use
      // needs its tool_result) and the post-tools llm step folds new messages in anyway. Only
      // teammate-BOT interleaves count — a human message landing mid-compose folds into the next
      // gate/turn as usual rather than forcing a rewrite of a finished reply.
      const interleaved =
        hasToolCalls || !aiText
          ? []
          : channel
              .since(newCursor, channelId)
              .filter((m) => m.authorBotId && m.authorBotId !== bot.id);
      if (
        interleaved.length > 0 &&
        state.revisionPasses < MAX_REVISION_PASSES
      ) {
        // Stale: demote the reply to a draft. The consumed batch still commits atomically and the
        // cursor still advances past what this step actually read; the interleaved messages stay
        // unconsumed and become the revision pass's normal injected input.
        return {
          messages: injected, // NO ai — the draft never enters durable history
          cursor: newCursor,
          draft: aiText,
          draftUsage: usageOf(ai),
          revisionPasses: state.revisionPasses + 1,
        };
      }
      // Fresh (or at the revision cap → post anyway; or a tool-call step; or a silent empty reply).
      // The draft is resolved either way: posted, superseded by this reply, or — when a revision
      // pass chose to act (tool calls) instead of posting — dropped, since the post-tools step
      // re-reads the channel fresh. Clearing here keeps `afterLlm`'s draft → llm route reachable
      // only from an actual suppression.
      return {
        messages: [...injected, ai],
        cursor: newCursor,
        draft: undefined,
        draftUsage: undefined,
      };
    };

    const toolsNode = new ToolNode(tools);

    // ── Recursion guard constants ──────────────────────────────────────────────────────────────────
    /** Minimum number of the bot's own AI messages in history before the guard is worth running. A
     * shorter history can't show a meaningful repetition pattern — skip to avoid false positives. */
    const GUARD_FLOOR = 6;
    /** The first-person pause message emitted when a loop is confirmed. Used as both the break-node
     * payload and the anti-spam sentinel (startsWith check so future rewording stays consistent). */
    const PAUSE_TEXT =
      "I think I'm going in circles here — pausing so I don't spin. Ping me when you want me to pick this back up.";
    const PAUSE_SENTINEL = "I think I'm going in circles here";

    /**
     * GUARD NODE — decide whether the bot is stuck in a no-progress loop.
     *
     * Runs on the respond path between `gate` and `fetch`. Returns `{ loopBreak: true }` when a
     * loop is detected; the conditional edge `afterGuard` routes to `break` instead of `fetch`.
     *
     * EVERY exit writes `loopBreak` EXPLICITLY — never `{}`. The flag rides in the CHECKPOINT, so
     * a skip that "changes nothing" would leave a previous turn's `true` in place and the
     * conditional edge would re-break forever on a stale verdict (observed live: pauses kept
     * firing on direct human pings, carrying an hour-old reasoning line, with every skip working
     * "correctly"). The annotation default only covers never-written threads.
     *
     * Fast-path skips (no Haiku call, all clearing the flag):
     *   - forced turn (job relay — synthetic message, loop detection irrelevant)
     *   - guard disabled via env
     *   - triggering message is human-authored (loops are bot-origin phenomena)
     *   - a human spoke ANYWHERE in the batch — a batch with a human in it deserves a real turn,
     *     never a fuse check (also closes the race where a teammate's fast reply lands after the
     *     human's and steals the "latest" slot)
     *   - last AI message is already the pause sentinel (anti break-spam: once paused, the guard
     *     re-arms only after the bot says something substantive again)
     *   - fewer than GUARD_FLOOR substantive own messages in history (not enough signal)
     *
     * The judged window EXCLUDES prior pause lines: the breaker's own output must never count as
     * loop evidence — a pause-polluted window otherwise re-confirms "looping" forever (observed:
     * eight consecutive self-confirming re-fires).
     */
    /** The skip verdict — clears any checkpointed break from a prior turn (see docstring). */
    const GUARD_SKIP: Partial<BotStateType> = {
      loopBreak: false,
      guardReasoning: undefined,
    };
    const guardNode = async (
      state: BotStateType,
    ): Promise<Partial<BotStateType>> => {
      if (state.forced) return GUARD_SKIP;
      if (!this.recursionGuard.isEnabled()) return GUARD_SKIP;
      // Only fire on bot-authored triggers — human messages don't form bot loops
      const latest = state.pending[state.pending.length - 1];
      if (!latest?.authorBotId) return GUARD_SKIP;
      // A human anywhere in the batch → real turn, no fuse check.
      if (state.pending.some((m) => !m.authorBotId)) return GUARD_SKIP;
      const ownMessages = state.messages.filter((m) => m.getType() === 'ai');
      // Anti break-spam: once paused, stay paused on bot-only chatter; the guard re-arms when the
      // bot next produces a substantive (non-pause) message of its own.
      const lastAiText = ownMessages.length
        ? flattenContent(ownMessages[ownMessages.length - 1].content).trim()
        : '';
      if (lastAiText.startsWith(PAUSE_SENTINEL)) return GUARD_SKIP;
      // Need enough SUBSTANTIVE history for a meaningful window — pause lines don't count.
      const substantive = ownMessages.filter(
        (m) => !flattenContent(m.content).trim().startsWith(PAUSE_SENTINEL),
      );
      if (substantive.length < GUARD_FLOOR) return GUARD_SKIP;
      // Render the rolling window: the bot's own last N substantive AI messages (text + tool-call note)
      const N = this.recursionGuard.windowSize();
      const windowText = substantive
        .slice(-N)
        .map((m) => {
          const text = flattenContent(m.content).trim();
          const calls = (m as AIMessage).tool_calls ?? [];
          const toolNote = calls.length
            ? ` [tools: ${calls.map((c) => c.name).join(', ')}]`
            : '';
          const line = `${bot.name}: ${text}${toolNote}`.trim();
          return line !== `${bot.name}:` ? line : null;
        })
        .filter((s): s is string => s !== null)
        .join('\n');
      if (!windowText.trim()) return GUARD_SKIP;
      const result = await this.recursionGuard.detect(bot, windowText);
      return {
        loopBreak: result.looping,
        guardReasoning: result.reasoning,
      };
    };

    /**
     * BREAK NODE — end the turn cleanly when a loop is confirmed.
     *
     * Mirrors `consumeNode`: consumes the pending batch (records the triggering messages in
     * history so the checkpoint stays honest), advances the cursor past them, appends a
     * first-person pause AIMessage, and clears `recalled`. Routes to `reconcile → END`.
     *
     * The pause carries the judge's REASONING — the diagnosis of what looped — so the breaker is
     * a learning signal, not just a fuse: the bot (and the channel) sees WHAT it was repeating,
     * and reconcile can keep the lesson. The text still starts with PAUSE_SENTINEL, so the
     * anti-spam/window checks keep matching.
     *
     * The conductor's existing stream handler surfaces the pause AIMessage automatically
     * (`if (msg.getType() === 'ai') commit(msg)`) — zero conductor changes required.
     */
    const breakNode = (
      state: BotStateType,
      config: RunnableConfig,
    ): Partial<BotStateType> => {
      const pending = state.pending;
      const newCursor = pending.length
        ? pending[pending.length - 1].seq + 1
        : channel.lengthOf(this.channelIdOf(config));
      const reason = state.guardReasoning?.trim();
      const pauseText = reason
        ? `${PAUSE_TEXT}\n(What I kept repeating: ${reason})`
        : PAUSE_TEXT;
      return {
        messages: [...pending.map(asInput), new AIMessage(pauseText)],
        cursor: newCursor,
        recalled: '',
      };
    };

    /** A compact note of a turn-ending action worth reconciling against (an opened or continued
     * session is a commitment being acted on), else undefined. Tool RESULTS stay hidden. */
    const toolActionNote = (m: AIMessage): string | undefined => {
      const tasks = (m.tool_calls ?? [])
        .filter(
          (c) => c.name === 'create_session' || c.name === 'reply_session',
        )
        .map((c) => {
          const text = c.args?.task ?? c.args?.message;
          return typeof text === 'string' ? text : '';
        })
        .filter(Boolean);
      return tasks.length
        ? `${bot.name}: (started background work — ${tasks.map((t) => `"${t}"`).join('; ')})`
        : undefined;
    };

    /** This turn's exchange — the messages added since `gate` marked `turnStart` — fed to the
     * reconcile passes. Tool-result/internal plumbing stays filtered out. */
    const turnTranscript = (state: BotStateType): string =>
      state.messages
        .slice(state.turnStart)
        .flatMap((m): string[] => {
          if (m.getType() === 'human') {
            const t = flattenContent(m.content).trim();
            return t ? [t] : [];
          }
          if (m.getType() === 'ai') {
            const lines: string[] = [];
            const t = flattenContent(m.content).trim();
            if (t) lines.push(`${bot.name}: ${t}`);
            const note = toolActionNote(m as AIMessage);
            if (note) lines.push(note);
            return lines;
          }
          return [];
        })
        .join('\n');

    /** The post-LLM write: reconcile durable facts (add/update/delete) against the turn.
     *
     * DISABLED 2026-06-12 (Dennis, during the first live standup) — the auto-capture is too
     * credulous: it stored Sam's ANTICIPATORY chatter ("ready to execute when the standup
     * closes") as accomplished facts ("#6 and #11 are approved"), recall fed them back as truth,
     * and Sam preferred memory over the board (which was correct the whole time). Stale session
     * facts from the same path also fed Alex's guard loop. OFF until the memory-system fix
     * (board ticket #10) lands; explicit remember()/recall() tools are unaffected — this only
     * silences the automatic post-turn write. The node + edges stay so the graph shape (and
     * checkpoints) don't change.
     */
    const reconcileMemoryNode = (): Promise<Partial<BotStateType>> => {
      // Disabled — see the docstring above. The original body, for the re-enable:
      //   const transcript = turnTranscript(state);
      //   if (transcript.trim())
      //     await this.reconcile.reconcileMemory(
      //       bot,
      //       transcript,
      //       getIdentity(config),
      //       state.decision,
      //     );
      return Promise.resolve({});
    };

    /** The post-LLM write: reconcile the reminders plate (add/complete/drop) against the turn. */
    const reconcileTaskNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const transcript = turnTranscript(state);
      if (transcript.trim())
        await this.reconcile.reconcileTasks(
          bot,
          transcript,
          getIdentity(config),
          state.decision,
        );
      return {};
    };

    /** Record the gated batch in the checkpoint without a model call (the ack/ignore path). */
    const consumeNode = (
      state: BotStateType,
      config: RunnableConfig,
    ): Partial<BotStateType> => {
      const pending = state.pending;
      const newCursor = pending.length
        ? pending[pending.length - 1].seq + 1
        : channel.lengthOf(this.channelIdOf(config));
      // recalled is reset here too — this path skips `fetch`, and an un-cleared value would ride
      // the checkpoint as a stale recall (deleted reminder ids included) until the next respond.
      return {
        messages: pending.map(asInput),
        cursor: newCursor,
        recalled: '',
      };
    };

    // Respond path now flows through the guard node first; ack/ignore path stays on consume.
    const route = (state: BotStateType): 'guard' | 'consume' =>
      state.decision === 'respond' ? 'guard' : 'consume';

    // After the guard decides: a confirmed loop routes to `break`, otherwise proceeds to `fetch`.
    const afterGuard = (state: BotStateType): 'fetch' | 'break' =>
      state.loopBreak ? 'break' : 'fetch';

    // When the llm loop is done, fan out to BOTH reconcile nodes (parallel, then join at END).
    const RECONCILE: ['reconcileMemory', 'reconcileTask'] = [
      'reconcileMemory',
      'reconcileTask',
    ];
    const afterLlm = (state: BotStateType): 'tools' | 'llm' | string[] => {
      // Draft check FIRST: a suppression returns WITHOUT appending its AI message, so `last` would
      // be stale history (in a crash-repaired thread it could even be a dangling tool_call AI —
      // routing that to `tools` would re-execute stale calls). llmNode clears `draft` on every
      // non-suppression return, so this route is reachable only from an actual suppression.
      if (state.draft) return 'llm'; // read-the-room revision pass
      const last = state.messages[state.messages.length - 1] as
        | AIMessage
        | undefined;
      return last?.tool_calls?.length ? 'tools' : RECONCILE;
    };

    // After tools run, END the turn (skip the loop back to `llm` that would otherwise force a chatty
    // text-only follow-up) when EVERY call in the triggering message is terminal AND all succeeded.
    // `every` (not `some`) is load-bearing: a message mixing a terminal tool with an informational
    // or fallible one loops back so that result is relayed.
    // If any terminal call has status:'error' we also loop back — a failed terminal tool must not
    // silently end the turn; the model needs a chance to react to the error ToolMessage.
    const afterTools = (state: BotStateType): 'llm' | string[] => {
      const lastAi = [...state.messages]
        .reverse()
        .find((m) => m.getType() === 'ai') as AIMessage | undefined;
      const calls = lastAi?.tool_calls ?? [];
      const allTerminal =
        calls.length > 0 && calls.every((c) => TERMINAL.has(c.name));
      if (!allTerminal) return 'llm';
      // Route back to llm when any terminal call failed — scan for ToolMessages whose call_id
      // belongs to the current AI message and whose status is 'error'.
      const callIds = new Set(
        calls.map((c) => c.id).filter(Boolean) as string[],
      );
      const anyFailed = state.messages.some(
        (m) =>
          m.getType() === 'tool' &&
          callIds.has((m as ToolMessage).tool_call_id) &&
          (m as ToolMessage).status === 'error',
      );
      return anyFailed ? 'llm' : RECONCILE;
    };

    return new StateGraph(BotState)
      .addNode('gate', gateNode)
      .addNode('guard', guardNode)
      .addNode('break', breakNode)
      .addNode('fetch', fetchNode)
      .addNode('llm', llmNode)
      .addNode('tools', toolsNode)
      .addNode('consume', consumeNode)
      .addNode('reconcileMemory', reconcileMemoryNode)
      .addNode('reconcileTask', reconcileTaskNode)
      .addEdge(START, 'gate')
      .addConditionalEdges('gate', route, ['guard', 'consume'])
      .addConditionalEdges('guard', afterGuard, ['fetch', 'break'])
      .addEdge('fetch', 'llm')
      .addConditionalEdges('llm', afterLlm, [
        'tools',
        'llm',
        'reconcileMemory',
        'reconcileTask',
      ])
      .addConditionalEdges('tools', afterTools, [
        'llm',
        'reconcileMemory',
        'reconcileTask',
      ])
      .addEdge('consume', 'reconcileMemory')
      .addEdge('consume', 'reconcileTask')
      .addEdge('break', 'reconcileMemory')
      .addEdge('break', 'reconcileTask')
      .addEdge('reconcileMemory', END)
      .addEdge('reconcileTask', END)
      .compile({ checkpointer: this.checkpointer });
  }
}
