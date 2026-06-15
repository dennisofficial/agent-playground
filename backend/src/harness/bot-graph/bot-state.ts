import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { ChannelMsg } from '../channel/channel.types';
import type { GateAction, MessageUsage } from '../domain/conductor-events';
import type { RefreshScope } from '../tools/tool.types';

/**
 * The three independently-refreshable slices of the pre-LLM context. Stored separately so the
 * post-tools `refreshContext` node can recompute only the dirtied parts without paying for a full
 * re-fetch every tool batch.
 * - `memory` — semantic facts + cross-project facts (embedding-based; set once by `recall`)
 * - `tasks`  — the reminders plate (cheap SQL; refreshed by add_task / complete_task)
 * - `work`   — worktrees + open sessions (registry reads; refreshed by create/remove_worktree, close_session)
 */
export interface ContextParts {
  work: string;
  memory: string;
  tasks: string;
}

/** Render order preserves today's output: facts/others → plate → worktrees/sessions. */
export const renderContext = (c: ContextParts): string =>
  [c.memory, c.tasks, c.work].filter((s) => s.trim()).join('\n\n');

/** What the conductor reads out of a node's streamed delta (a partial of BotState). */
export interface BotStateDelta {
  messages?: BaseMessage[];
  cursor?: number;
  decision?: GateAction;
  ackEmoji?: string;
  /** Suggestion block from the previous turn's memory reconcile — injected into the next turn's
   * context so the agent can act on it with remember / update_memory / forget. '' = nothing. */
  memorySuggestions?: string;
  /** @deprecated Legacy single-string compaction summary written by pre-TKT-38 code.
   * Read-only compat shim: checkpoints that carry a `summary` string are deserialized into
   * this field so `llmNode` / `compactionNode` can derive `effectiveSummaries` from it.
   * Never written by TKT-38+ code; remove once all active threads have cycled through at
   * least one new compaction pass. */
  summary?: string;
  /** Rolling compaction summary queue (block 2). [] = no compaction has occurred yet. */
  summaries?: string[];
  /** messages[] index of the first verbatim-tail message. 0 = no compaction. */
  summarizedUpTo?: number;
  /** Monotonically incrementing compaction event count per thread. */
  compactionVersion?: number;
  /** A reaction emoji to surface immediately — the gate's "seen, working" 👀 on a real respond. */
  reaction?: string;
  /** The channel-message id this turn's reaction (👀 or ack) is ON — chosen HERE in the graph so the
   * conductor can tell the surface which message to fold the reaction into. */
  reactionTargetId?: string;
  /** The pre-LLM observability snapshot — written once by `recall` and reset by `mark_seen`. The
   * conductor emits exactly one `recall` event per respond turn from this field. `llm` renders live
   * context from `context` instead (so mid-turn refreshes don't emit extra recall events). */
  recalled?: string;
  /** Debug only: the soft gate's one-line rationale. Absent for hard rules. */
  reasoning?: string;
  /** Debug only: token usage for this turn's gate call. Absent for hard rules. */
  gateUsage?: { input: number; output: number };
  /** The gate's input-token count for this turn — the best proxy for total context size. Written
   * by `gateNode` on every path (0 when the gate call was skipped). Used by `compactionNode` to
   * decide whether to compact. Last-write-wins (same as all non-message state). */
  lastContextTokens?: number;
  /** Set by the `loop_guard` node when a no-progress loop is detected — routes to `pause`. */
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
  /** TOOL-LOOP guard verdict for this iteration — routes out of `tool_loop_guard` (debug only). */
  toolLoopVerdict?: 'pass' | 'correct' | 'pause';
  /** Debug only: the tool-loop guard's one-line rationale when it fired. */
  toolLoopReasoning?: string;
}

export const BotState = Annotation.Root({
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
  /** The gate's input-token count for this turn — last-write-wins proxy for context size.
   * Written by `gateNode` on every path; read by `compactionNode`. 0 = gate was skipped. */
  lastContextTokens: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** The non-own batch the gate decided on — consumed by `mark_seen` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({
    reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [],
    default: () => [],
  }),
  /** Ephemeral pre-LLM memory context (the `recall` node's output). Re-injected each llm call
   * like the persona, NEVER written into `messages`. Overwritten on EVERY path — by `recall`
   * (respond) and reset by `mark_seen` (ack/ignore) — so a stale recall never survives the
   * checkpoint. This is the observability snapshot: written once by `recall`, read by the conductor
   * for the `recall` event. `llm` renders live context from `context` instead. */
  recalled: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /** The three independently-refreshable context slices. `llm` renders them to one string each
   * call via `renderContext`. Reset by `mark_seen` / `pause` alongside `recalled`. */
  context: Annotation<ContextParts>({
    reducer: (_: ContextParts, b: ContextParts) =>
      b ?? { work: '', memory: '', tasks: '' },
    default: () => ({ work: '', memory: '', tasks: '' }),
  }),
  /** The turn's retrieval query — persisted so `refreshContext` can re-run `fetchMemory` after the
   * cursor has advanced past the fresh messages. Reset by `mark_seen` / `pause`. */
  recallQuery: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /** `messages.length` at the start of this turn (set by `gate`), so reconcile can slice just this
   * turn's exchange out of the full persisted history. */
  turnStart: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Set by the `loop_guard` node when a no-progress loop is detected. Routes to `pause` instead of
   * `recall`. Reset to false on every run (default) so a prior pause doesn't poison the next turn. */
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
   * during model.invoke). Survives exactly one edge — llm → llm — where the revision note
   * carries it back to the model. NEVER enters `messages`: durable history records only what was
   * actually said. Reset explicitly by `gate` every run (Annotation defaults don't re-apply on an
   * existing thread), so a draft orphaned by a crash is dropped, never replayed. */
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
  /** DORMANCY accumulator: consecutive soft-gate IGNOREs in this room (the checkpoint thread is
   * per (bot, room)). At/above the threshold the bot is "dormant" and stops paying for the soft
   * gate until a wake trigger (its name/@/broadcast, or a lane keyword) fires. Persists across
   * turns; `gate` rewrites it explicitly on every path (reset to 0 on respond/ack/forced, +1 on a
   * soft ignore, unchanged on a cheap/hard ignore). */
  consecutiveSoftIgnores: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** DORMANCY per-turn routing flag: set by `gate` when a dormant bot cheap-ignores an off-lane
   * message (no wake trigger). Routes `mark_seen → END`, skipping the reconcile LLM call. Like
   * `draft`/`loopBreak`, written explicitly every run (annotation defaults don't re-apply on an
   * existing thread, so a stale `true` would otherwise skip reconcile on the next turn). */
  dormantSkip: Annotation<boolean>({
    reducer: (_: boolean, b: boolean) => b ?? false,
    default: () => false,
  }),
  /**
   * Suggestion block from the previous turn's memory reconcile. Written by
   * `reconcileNode` (possibly '' when nothing qualifies); read by `recallNode` the NEXT turn and
   * injected into the context so the agent sees and acts on it. Overwritten every turn — no stale
   * lifecycle. Empty string → no suggestions slot injected.
   */
  memorySuggestions: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /**
   * @deprecated Legacy single-string compaction summary written by pre-TKT-38 code.
   * Registered as a channel so LangGraph deserializes old checkpoints that carry a `summary`
   * field into `state.summary`. `llmNode` and `compactionNode` derive `effectiveSummaries`
   * from this field when `summaries` is empty and `summarizedUpTo > 0`, preserving the
   * previously-compacted context instead of replaying full durable history. NEVER written by
   * TKT-38+ code. Remove once all active threads have cycled through at least one new
   * compaction pass under the TKT-38 architecture.
   */
  summary: Annotation<string>({
    reducer: (_: string, b: string) => b ?? '',
    default: () => '',
  }),
  /**
   * Rolling compaction summary queue (block 2). Written by `compactionNode` when block 3
   * (verbatim tail) exceeds COMPACTION_TRIGGER_TOKENS. Each entry is a human-readable
   * rolling summary covering the compacted portion at that pass. Ordered oldest → newest;
   * FIFO-evicted at MAX_SUMMARIES. [] = no compaction has occurred yet.
   * In `llmNode`, when non-empty, the queue is rendered as a structured summary block
   * immediately before the verbatim tail (block 3). `summaries.length > 0` is the single
   * source of truth for "this thread has been compacted."
   */
  summaries: Annotation<string[]>({
    reducer: (_: string[], b: string[]) => b ?? [],
    default: () => [],
  }),
  /**
   * Index into `messages[]` of the first verbatim-tail message. 0 = no compaction.
   * When `summaries.length > 0`, `llmNode` uses `messages.slice(summarizedUpTo)` as the
   * live history, prefixed by the rendered summary block. `compactionNode` sets this to
   * the token-budget cut point returned by `findCompactionCutPoint`, which always lands
   * at a HumanMessage boundary via `pairSafeBoundary`.
   */
  summarizedUpTo: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /**
   * Monotonically incrementing compaction event count for this thread. Incremented each
   * time `compactionNode` fires; used as the `version` field in the `compaction_summaries` audit
   * table. 0 = no compaction has occurred.
   */
  compactionVersion: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** TOOL-LOOP guard: this iteration's verdict, driving the conditional edge out of
   * `tool_loop_guard` (`pause` → reconcile, `correct` → refreshContext, else the normal
   * refresh-scope route). Written explicitly every pass through the node; reset by `gate` each run
   * (annotation defaults don't re-apply on an existing checkpoint thread). */
  toolLoopVerdict: Annotation<'pass' | 'correct' | 'pause' | undefined>({
    reducer: (_: unknown, b: 'pass' | 'correct' | 'pause' | undefined) => b,
    default: () => undefined,
  }),
  /** TOOL-LOOP guard: how many times a stuck tool-loop has been CORRECTED this turn. The first
   * stuck verdict corrects (nudge + forced refresh); a subsequent one escalates to a pause. Reset
   * by `gate` each run. */
  toolLoopCorrections: Annotation<number>({
    reducer: (_: number, b: number) => b ?? 0,
    default: () => 0,
  }),
  /** Debug only: the tool-loop guard's one-line rationale when it fired. Rides in the checkpoint;
   * never surfaced in the event stream. */
  toolLoopReasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** TOOL-LOOP guard: a transient one-shot instruction injected into the NEXT `llm` invoke as a
   * HumanMessage (mirrors `draft`), telling the bot the action already succeeded — STOP retrying.
   * NEVER persisted into `messages` (so it's never committed to the channel); cleared by `llmNode`
   * after it renders, and reset by `gate` each run. */
  toolLoopInstruction: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** TOOL-LOOP guard: context scopes the guard forces `refreshContext` to recompute on a correction
   * (so the refresh is explicit, not rediscovered from message order). Consumed + cleared by
   * `refreshContextNode`; reset by `gate` each run. */
  forcedRefreshScopes: Annotation<RefreshScope[] | undefined>({
    reducer: (_: unknown, b: RefreshScope[] | undefined) => b,
    default: () => undefined,
  }),
});

export type BotStateType = typeof BotState.State;
