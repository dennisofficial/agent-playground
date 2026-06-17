import { EnvService } from '@core/config/env/env.service';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type ToolMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { Logger } from '@nestjs/common';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import { AddressingGate } from '../conductor/addressing-gate';
import { getIdentity } from '../domain/identity';
import { flattenContent } from '../domain/text';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { CompactionSummaryStore } from '../memory/compaction-summary.store';
import {
  COMPACTION_TRIGGER_TOKENS,
  MAX_SUMMARIES,
  MAX_SUMMARY_TOKENS,
  VERBATIM_BUFFER_TOKENS,
} from '../memory/memory-constants';
import { FetchService } from '../memory/fetch.service';
import { ReconcileService } from '../memory/reconcile.service';
import { ToolLoopGuardService } from '../recursion-guard/tool-loop-guard.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { DEFAULT_CHAT_TOOLSET } from '../tools/default-toolset';
import { EngineToolFactory } from '../tools/engine-tool.factory';
import { ToolRegistry } from '../tools/tool.registry';
import type { RefreshScope } from '../tools/tool.types';
import { WorktreeService } from '../worktrees/worktree.service';
import {
  GAP_THRESHOLD_DEFAULT_MS,
  buildTimeContext,
  withDividers,
} from './channel-render';
import {
  type BotStateType,
  type ContextParts,
  renderContext,
} from './bot-state';
import {
  asInput,
  compactPriorToolResults,
  dropLeadingOrphanToolResults,
  filterToolDispatchMessages,
  findCompactionCutPoint,
  repairDanglingToolCalls,
  sumMessageTokens,
  usageOf,
  withCacheBreakpoint,
} from './message-helpers';
import {
  MAX_REVISION_PASSES,
  interleavedMessages,
  revisionNote,
} from './read-the-room';
import { makeRefreshScopesFromTurn } from './routing';

/** One element of an AIMessage's `tool_calls` array. */
type ToolCall = NonNullable<AIMessage['tool_calls']>[number];

/**
 * A stable, order-independent string key for a tool call's arguments — recursively sorts object
 * keys so `{a,b}` and `{b,a}` hash identically. Used by `tool_loop_guard` to detect that the SAME
 * call is being re-issued regardless of how the model happened to order its arg keys.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

/** The signature `tool_loop_guard` counts on: tool name + stable-hashed args. */
const callSignature = (c: ToolCall): string =>
  `${c.name}::${stableStringify(c.args ?? {})}`;

/** A short one-line summary of a tool result for the Haiku classifier (status + trimmed text). */
function summarizeToolResult(m: ToolMessage): string {
  const text = flattenContent(m.content).trim().replace(/\s+/g, ' ');
  const head = text.length > 160 ? `${text.slice(0, 160)}…` : text;
  return m.status === 'error' ? `error: ${head}` : `ok: ${head}`;
}

/**
 * The node IMPLEMENTATIONS of the orchestrator's (Atlas's) turn-graph — gate, consume, recall, llm,
 * tools, tool_loop_guard, refreshContext, reconcile, compact. `BotGraphFactory` owns the DI + the
 * graph TOPOLOGY (which node goes where); this owns what each node DOES. `forBot(bot)` returns the
 * per-bot node functions plus the bot's context-refresh scope map (which the routing predicates in
 * routing.ts close over). The `gate` node is the entry: it classifies respond/skip (the addressing
 * gate, in-graph so a skip lands in the turn's Langfuse trace) and either runs the turn (recall →
 * llm …) or routes to `consume` (advance the cursor, no model call).
 *
 * Constructed manually by the factory (not a Nest provider) so the factory keeps its existing
 * constructor — the services it injects are handed straight through here.
 */
export class BotGraphNodes {
  private readonly logger = new Logger(BotGraphNodes.name);
  private readonly gapThresholdMs: number;
  constructor(
    private readonly channel: ChannelService,
    private readonly channelRegistry: ChannelRegistryService,
    private readonly toolRegistry: ToolRegistry,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    private readonly worktrees: WorktreeService,
    private readonly sessions: SessionRegistry,
    gapThresholdMs: number,
    private readonly engineTools?: EngineToolFactory,
    private readonly compactionStore?: CompactionSummaryStore,
    private readonly toolLoopGuard?: ToolLoopGuardService,
    // Appended last + optional so the positional unit specs (which construct BotGraphNodes without a
    // gate) keep their "always respond" behavior — the gate node treats an absent gate as respond.
    private readonly gate?: AddressingGate,
  ) {
    this.gapThresholdMs = gapThresholdMs;
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

  /** Build the per-bot node functions for the turn graph. */
  forBot(bot: EmployeeDefinition) {
    const channel = this.channel;
    const allowlist = bot.tools ?? DEFAULT_CHAT_TOOLSET;
    const tools = this.toolRegistry.toStructuredTools(allowlist);
    // Tool-triggered CAPABILITIES (e.g. Nora's deep_research) bind here at graph-build, alongside the
    // static allowlist and under the same cache_control breakpoint. (Absent in unit specs where
    // engineTools isn't injected.)
    if (this.engineTools) {
      const cap = this.engineTools.buildTools(bot, this.persona.context());
      tools.push(...cap.tools);
    }
    // Context-refreshing tools: name → scopes map, derived from the allowlist's `refreshesContext`
    // flags. Used by `makeAfterToolLoopGuard` (routing) and `refreshContextNode` (recompute).
    const REFRESH = this.toolRegistry.refreshScopesByName(allowlist);
    const refreshScopesFromTurn = makeRefreshScopesFromTurn(REFRESH);

    /**
     * The per-turn reset the old prelude node did, run on EVERY gate path. `turnStart` marks where
     * this turn's messages begin so `reconcile` slices just this exchange; the read-the-room /
     * tool-loop fields reset because Annotation defaults don't re-apply on an existing checkpoint
     * thread — a stale draft / verdict / revision count from a prior turn would otherwise poison it.
     */
    const resetsFor = (state: BotStateType): Partial<BotStateType> => ({
      turnStart: state.messages.length,
      draft: undefined,
      draftUsage: undefined,
      revisionPasses: 0,
      toolLoopVerdict: undefined,
      toolLoopCorrections: 0,
      toolLoopInstruction: undefined,
      forcedRefreshScopes: undefined,
    });

    /**
     * GATE NODE — the turn entry (replaces the old prelude). Classifies respond vs skip for a
     * room-triggered turn, then routes: `respond` → recall (the normal turn), anything else →
     * consume (advance the cursor, no model call). The Haiku classify receives `config`, so it nests
     * in this turn's Langfuse trace — a SKIP is now visible in the SAME trace as the turn it gated,
     * which is the whole point of running the gate in-graph. Trade-off: every room-triggered turn now
     * boots the graph (a checkpoint load + a gate/consume write even on skip).
     *
     * Hard rules (DM / broadcast / @Atlas) and the soft Haiku classify live in AddressingGate.decide;
     * only the genuinely-ambiguous middle pays for a model call (so only those produce a gate span).
     * `state.forced` (seed / job relay) and the unit-spec path (no gate injected) bypass to respond.
     * The skip class maps to `decision: 'ignore'` — GateAction has no 'skip'.
     */
    const gateNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const resets = resetsFor(state);
      if (state.forced || !this.gate)
        return { decision: 'respond', pending: [], ...resets };
      const channelId = this.channelIdOf(config);
      const batch = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      if (batch.length === 0)
        return { decision: 'ignore', pending: [], ...resets }; // raced clear since hasWork
      const latest = batch[batch.length - 1];
      const isDm = !this.channelRegistry.isChannelKind(channelId);
      // History = the recent room tail INCLUDING Atlas's own messages, so a bare reply to Atlas's own
      // question ("yes please" answering "Want me to …?") reads as a continuation, not an aside.
      const history = channel
        .snapshot(channelId)
        .slice(-8)
        .map((m) => `${m.author}: ${m.text}`)
        .join('\n');
      const verdict = await this.gate.decide(
        { bot, isDm, text: latest.text, history },
        config,
      );
      return {
        decision: verdict === 'respond' ? 'respond' : 'ignore',
        pending: batch,
        // The gated message — the conductor folds the 💭 "composing" (respond) / 👀 "seen" (skip)
        // reaction onto it. Absent on the forced/empty paths (no single triggering message).
        reactionTargetId: latest.id,
        ...resets,
      };
    };

    /**
     * CONSUME NODE — the skip path. Advances the cursor PAST the gated batch without a model call.
     * `seq + 1` (NOT lengthOf) so a message that arrived during the gate's classify still gets its
     * own future gate pass. Skipped chatter is NOT written into `messages` (Atlas doesn't carry
     * ignored human-to-human messages into its LLM context — matches prior behavior); routes straight
     * to END, no reconcile.
     */
    const consumeNode = (
      state: BotStateType,
      config: RunnableConfig,
    ): Partial<BotStateType> => {
      const pending = state.pending;
      const newCursor = pending.length
        ? pending[pending.length - 1].seq + 1
        : channel.lengthOf(this.channelIdOf(config));
      return { cursor: newCursor };
    };

    /** Out of `gate`: the normal turn (respond) or the cursor-advance skip path. */
    const route = (state: BotStateType): 'recall' | 'consume' =>
      state.decision === 'respond' ? 'recall' : 'consume';

    /**
     * The pre-LLM context read: assemble the standing-context core + working-state slots into
     * `recalled`. FetchService.fetchContext no longer does semantic recall (no embedding)
     * — it returns the tiny always-on core (role, project, team prefs) + active board tasks +
     * reminders. The live work state (worktrees + sessions) is joined in from `workContext`.
     * Always set recalled (even to '') so a stale recall from a prior turn never lingers.
     */
    const recallNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const channelId = this.channelIdOf(config);
      const fresh = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      // Build the retrieval query from fresh messages + a few lines of prior context. Stored in
      // `recallQuery` for potential future use (semantic recall reactivation); not consumed by
      // fetchMemory in Phase 3 (standing context + board tasks — no embedding needed).
      const freshText = fresh.map((m) => `${m.author}: ${m.text}`).join('\n');
      const priorTail = fresh.length
        ? this.historyBefore(fresh[0].seq, channelId, 3)
        : '';
      const query = [priorTail, freshText].filter((s) => s.trim()).join('\n');
      const id = getIdentity(config);
      // Three independent reads — run in parallel. Each degrades to '' on error so a service
      // outage never aborts the turn.
      // Pass the previous turn's memorySuggestions so the assembler can inject them (Phase 2).
      // Pass a compaction note so the assembler surfaces a brief meta-note when the
      // session has been compacted (the full summaries block is injected in llmNode as history).
      // Check the new summaries queue first; fall back to the legacy single-string `summary`
      // field for pre-TKT-38 checkpoints (read-only compat — never written by new code).
      const isCompacted =
        state.summaries.length > 0 ||
        (state.summarizedUpTo > 0 && !!state.summary);
      const compactionNote = isCompacted
        ? `Earlier conversation has been summarized (${state.summaries.length || 1} summary block${(state.summaries.length || 1) > 1 ? 's' : ''}, covers messages 1–${state.summarizedUpTo}). See session summaries in conversation history above.`
        : undefined;
      const [memory, tasks, work] = await Promise.all([
        this.fetchService
          .fetchMemory(bot, id, state.memorySuggestions, compactionNote)
          .catch(() => ''),
        this.fetchService.fetchTasks(bot, id).catch(() => ''),
        this.workContext(bot).catch(() => ''),
      ]);
      const context: ContextParts = { memory, tasks, work };
      // recalled = the one-shot pre-LLM snapshot for the conductor's `recall` event.
      // llm renders live context from `context` on every call.
      return {
        context,
        recalled: renderContext(context),
        recallQuery: query,
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
      // Three-block context: (1) system prompt, (2) summary queue if compacted, (3) verbatim tail.
      // "Verbatim" = durable-verbatim: block-3 messages live in the checkpoint and are NEVER
      // promoted to a rolling summary (that is compactionNode's job). Read-time transforms
      // (repairDanglingToolCalls, compactPriorToolResults, filterToolDispatchMessages) still
      // apply at model-call time; they do not mutate the checkpoint.
      // Back-compat: a legacy checkpoint carries `summary` (string) + `summarizedUpTo > 0` but
      // `summaries = []`. Derive `effectiveSummaries` from the old field so the thread is treated
      // as compacted and its full durable history is NOT replayed (which could blow the context
      // window for heavily-compacted threads). Once compactionNode runs it appends to `summaries`
      // (seeded from effectiveSummaries), so the thread auto-upgrades on the next compaction pass.
      // repair → compact prior tool results → filter text-less dispatches → cache breakpoints.
      const effectiveSummaries =
        state.summaries.length > 0
          ? state.summaries
          : state.summarizedUpTo > 0 && state.summary
            ? [state.summary]
            : [];
      const compacted = effectiveSummaries.length > 0;
      const rawHistory = compacted
        ? dropLeadingOrphanToolResults(
            state.messages.slice(state.summarizedUpTo),
          )
        : state.messages;
      const history = filterToolDispatchMessages(
        compactPriorToolResults(repairDanglingToolCalls(rawHistory)),
      );
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
      // Render from the LIVE context (may have been refreshed by `refreshContext` after tools ran),
      // not from `state.recalled` (which is the one-shot pre-LLM snapshot for the conductor).
      const liveContext = renderContext(state.context);
      // Block 2: render the rolling summary queue before the verbatim tail (block 3).
      // Position: [persona] → [summaries (if any)] → [verbatim tail] → [memory] → [time] → [fresh] → [draft]
      const summaryMessages = compacted
        ? [
            new HumanMessage(
              `(Conversation summary so far — oldest first, each block covers an earlier span:\n\n` +
                effectiveSummaries
                  .map(
                    (s, i) =>
                      `[Summary ${i + 1}/${effectiveSummaries.length}]\n${s}`,
                  )
                  .join('\n\n') +
                `)`,
            ),
          ]
        : [];
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
        ...summaryMessages,
        ...cachedHistory,
        ...(liveContext
          ? [
              new HumanMessage(
                `(Relevant memory — for your reference:\n${liveContext})`,
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
        // TOOL-LOOP correction: a one-shot authoritative nudge from `tool_loop_guard` telling the
        // bot it's re-issuing an already-successful call. Rendered as a transient HumanMessage (like
        // the draft note) — NEVER persisted into `messages`, so it's never committed to the channel.
        ...(state.toolLoopInstruction
          ? [new HumanMessage(state.toolLoopInstruction)]
          : []),
      ];
      // Built per-invocation (not at graph-build) so it reads the CURRENT turn's tenant key from
      // the credential context — one compiled graph per bot serves every workspace.
      const model = this.models.buildModel().bindTools(tools);
      const ai = await model.invoke(convo, config);
      const aiText = flattenContent(ai.content).trim();
      const hasToolCalls = ((ai as AIMessage).tool_calls?.length ?? 0) > 0;
      // READ-THE-ROOM check: synchronous (same JS tick as the return below — the in-memory channel
      // is synchronous, so nothing interleaves between this read and the checkpoint write request).
      // Any non-own message landing mid-compose (a teammate's reply OR the user adding more — e.g.
      // the rest of a fragmented message) stales the draft. Only a FINAL text post is gated: a
      // tool-call step must enter history intact (a tool_use needs its tool_result) and the
      // post-tools llm step folds new messages in anyway.
      const interleaved =
        hasToolCalls || !aiText
          ? []
          : interleavedMessages(channel, channelId, newCursor, bot.id);
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
          toolLoopInstruction: undefined, // one-shot: consumed by this invoke's prompt
        };
      }
      // Fresh (or at the revision cap → post anyway; or a tool-call step; or a silent empty reply).
      // The draft is resolved either way: posted, superseded by this reply, or — when a revision
      // pass chose to act (tool calls) instead of posting — dropped, since the post-tools step
      // re-reads the channel fresh. Clearing here keeps `afterLlm`'s draft → llm route
      // reachable only from an actual suppression.
      return {
        messages: [...injected, ai],
        cursor: newCursor,
        draft: undefined,
        draftUsage: undefined,
        toolLoopInstruction: undefined, // one-shot: consumed by this invoke's prompt
      };
    };

    const toolsNode = new ToolNode(tools);

    /** The first-person pause message `tool_loop_guard` emits when a stuck tool-loop persists past a
     * correction — a learning signal, not just a fuse (the conductor surfaces the AIMessage). */
    const PAUSE_TEXT =
      "I think I'm going in circles here — pausing so I don't spin. Ping me when you want me to pick this back up.";

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

    /**
     * RECONCILE NODE — the single post-turn pass, reached on every path (respond, ack/ignore,
     * pause). Runs two passes concurrently:
     *
     *  1. `reconcileMemory`: read-only suggestion pass — returns a short human-readable
     *     block stored in `memorySuggestions`. NEVER writes to the store; the agent commits via
     *     its own remember / update_memory / forget tools. Returns '' for off-class turns.
     *
     *  2. `reconcileTasks`: captures new forward commitments, completes finished ones, drops stale.
     *     Still auto-writing — Dennis's consent decision applies to durable facts, not reminders.
     *
     * Both are fire-and-forget: an error in one must not abort the turn.
     */
    const reconcileNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const transcript = turnTranscript(state);
      const id = getIdentity(config);
      // Run both passes concurrently. memorySuggestions is always written (even '') so a stale
      // value from a prior turn never lingers in the checkpoint.
      const [memorySuggestions] = await Promise.all([
        transcript.trim()
          ? this.reconcile.reconcileMemory(bot, transcript, id, state.decision)
          : Promise.resolve(''),
        transcript.trim()
          ? this.reconcile.reconcileTasks(
              bot,
              transcript,
              id,
              state.decision,
              config,
            )
          : Promise.resolve(),
      ]);
      return { memorySuggestions };
    };

    /**
     * REFRESH_CONTEXT NODE — recompute only the context slices dirtied by the just-run tool batch.
     *
     * Runs between `tools` and `llm` when a state-mutating tool call ran (create/remove_worktree,
     * close_session, remember/update_memory/forget, add/complete_task). Only the flagged scopes are
     * re-fetched — a memory-only refresh doesn't re-list worktrees, and vice-versa. Detection is
     * name-based: a failed mutation still triggers a harmless, idempotent recompute. Errors degrade
     * silently, keeping the previous slice intact.
     *
     * `recalled` is NOT updated — it's the one-shot pre-LLM snapshot for the conductor's `recall`
     * event. No duplicate `recall` events are emitted mid-turn.
     */
    const refreshContextNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      // A tool-loop CORRECTION forces explicit scopes (decoupled from message order); otherwise
      // discover them from the just-run tool batch as usual.
      const scopes = state.forcedRefreshScopes
        ? new Set<RefreshScope>(state.forcedRefreshScopes)
        : refreshScopesFromTurn(state);
      const id = getIdentity(config);
      const next: ContextParts = { ...state.context };
      const refreshWork = scopes.has('work')
        ? this.workContext(bot)
            .then((w) => {
              next.work = w;
            })
            .catch(() => {})
        : Promise.resolve();
      // Preserve the compaction note on mid-turn refreshes so the assembler slot stays
      // consistent. memorySuggestions is intentionally omitted (unchanged during a refresh).
      // Check both the new summaries queue and the legacy single-string summary field.
      const refreshIsCompacted =
        state.summaries.length > 0 ||
        (state.summarizedUpTo > 0 && !!state.summary);
      const refreshCompactionNote = refreshIsCompacted
        ? `Earlier conversation has been summarized (${state.summaries.length || 1} summary block${(state.summaries.length || 1) > 1 ? 's' : ''}, covers messages 1–${state.summarizedUpTo}). See session summaries in conversation history above.`
        : undefined;
      const refreshMemory = scopes.has('memory')
        ? this.fetchService
            .fetchMemory(bot, id, undefined, refreshCompactionNote)
            .then((m) => {
              next.memory = m;
            })
            .catch(() => {})
        : Promise.resolve();
      const refreshTasks = scopes.has('tasks')
        ? this.fetchService
            .fetchTasks(bot, id)
            .then((t) => {
              next.tasks = t;
            })
            .catch(() => {})
        : Promise.resolve();
      await Promise.all([refreshWork, refreshMemory, refreshTasks]);
      // Clear the forced scopes (one-shot) so a later organic refresh this turn discovers normally.
      return { context: next, forcedRefreshScopes: undefined }; // recalled untouched — no 2nd recall event
    };

    /**
     * TOOL_LOOP_GUARD NODE — catch a bot re-issuing the SAME tool call inside the `llm ⇄ tools`
     * loop (the failure the turn-entry `loop_guard` can't see: it watches spoken messages at turn
     * boundaries, not mid-turn tool calls). Sits on every continuation out of `tools` (a plain edge
     * from `tools`; no tool ends the turn directly).
     *
     * Two stages:
     *  1. DETERMINISTIC prefilter — count identical `tool+stable-args` signatures across this turn's
     *     tool calls. Below `threshold()` → pass (no LLM cost on the common path).
     *  2. Haiku judge (only when the prefilter trips) — tell a stuck loop from a legit poll/retry.
     *
     * Escalating intervention on a `stuck` verdict:
     *  - first time (`toolLoopCorrections === 0`) → CORRECT: stage a one-shot `toolLoopInstruction`
     *    (authoritative "it already succeeded, stop") + force a context refresh of the tool's scopes,
     *    then let the bot continue. Mirrors the stale-context root cause (Alex hammering close_session).
     *  - still stuck after a correction → PAUSE: append a first-person pause AIMessage (committed to
     *    the channel, like `pauseNode`) and route to reconcile → END.
     *
     * EVERY exit writes `toolLoopVerdict` EXPLICITLY (the field rides the checkpoint) so a prior
     * iteration's verdict can never re-route a later one.
     */
    const toolLoopGuardNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      const PASS: Partial<BotStateType> = { toolLoopVerdict: 'pass' };
      const tlg = this.toolLoopGuard;
      if (!tlg?.isEnabled()) return PASS;
      // The just-run tool-call AI message — we only act on a signature it actually re-issued.
      const lastAi = [...state.messages]
        .reverse()
        .find((m) => m.getType() === 'ai') as AIMessage | undefined;
      const lastCalls = lastAi?.tool_calls ?? [];
      if (!lastCalls.length) return PASS;
      // Count signatures across THIS turn's tool calls (from turnStart).
      const turnAis = state.messages
        .slice(state.turnStart)
        .filter((m) => m.getType() === 'ai') as AIMessage[];
      const counts = new Map<string, number>();
      for (const ai of turnAis)
        for (const c of ai.tool_calls ?? []) {
          const sig = callSignature(c);
          counts.set(sig, (counts.get(sig) ?? 0) + 1);
        }
      // Pick the most-repeated signature among the just-run calls that crossed the threshold.
      const threshold = tlg.threshold();
      let tripped: { call: ToolCall; sig: string; count: number } | undefined;
      for (const c of lastCalls) {
        const sig = callSignature(c);
        const count = counts.get(sig) ?? 0;
        if (count >= threshold && (!tripped || count > tripped.count))
          tripped = { call: c, sig, count };
      }
      if (!tripped) return PASS;
      // Collect this signature's results this turn (ToolMessages by tool_call_id), oldest first.
      const callIds = new Set<string>();
      for (const ai of turnAis)
        for (const c of ai.tool_calls ?? [])
          if (callSignature(c) === tripped.sig && c.id) callIds.add(c.id);
      const results = state.messages
        .slice(state.turnStart)
        .filter(
          (m) =>
            m.getType() === 'tool' &&
            callIds.has((m as ToolMessage).tool_call_id),
        )
        .map((m) => summarizeToolResult(m as ToolMessage));
      const decision = await tlg.detect(
        bot,
        {
          toolName: tripped.call.name,
          args: stableStringify(tripped.call.args ?? {}),
          results,
        },
        config,
      );
      if (decision.verdict === 'progressing')
        return {
          toolLoopVerdict: 'pass',
          toolLoopReasoning: decision.reasoning,
        };
      // stuck
      const corrections = state.toolLoopCorrections ?? 0;
      if (corrections === 0) {
        const scopes = [...(REFRESH.get(tripped.call.name) ?? [])];
        const lastResult = results[results.length - 1] ?? 'it already ran';
        const because = decision.reasoning ? ` (${decision.reasoning})` : '';
        const instruction =
          `You've called \`${tripped.call.name}\` ${tripped.count}× this turn with the same arguments — ` +
          `it already ran (latest result: ${lastResult}). Stop re-issuing it${because}. ` +
          `Your context below has been refreshed to reflect the current state.`;
        return {
          toolLoopVerdict: 'correct',
          toolLoopReasoning: decision.reasoning,
          toolLoopCorrections: corrections + 1,
          toolLoopInstruction: instruction,
          forcedRefreshScopes: scopes,
        };
      }
      // Persisted after a correction → pause (visible learning signal, like pauseNode).
      const reason = decision.reasoning?.trim();
      const pauseText = reason
        ? `${PAUSE_TEXT}\n(What I kept repeating: ${reason})`
        : PAUSE_TEXT;
      return {
        toolLoopVerdict: 'pause',
        toolLoopReasoning: decision.reasoning,
        messages: [new AIMessage(pauseText)],
      };
    };

    /**
     * COMPACTION NODE — runs sequentially after `reconcile` on every path.
     *
     * Three-block token-based compaction:
     *   - Block 1: system prompt (always present; excluded from token math).
     *   - Block 2: rolling summary queue (`summaries`); max MAX_SUMMARIES entries, FIFO.
     *   - Block 3: verbatim tail — from `summarizedUpTo` to the end of `messages`.
     *
     * Trigger: block 3 estimated tokens > COMPACTION_TRIGGER_TOKENS (strictly greater).
     * Estimation uses Math.ceil(chars / 4) — fast, no tokenizer dependency.
     *
     * When the trigger fires:
     *   1. Calls `findCompactionCutPoint` (which delegates pair-safety to `pairSafeBoundary`)
     *      to find the new tail start within VERBATIM_BUFFER_TOKENS.
     *   2. Calls `buildModel()` to produce a rolling summary of the compaction window.
     *   3. Appends the new summary to `summaries`; evicts the oldest if > MAX_SUMMARIES.
     *   4. Persists an audit row to `compaction_summaries`.
     *   5. Returns `{ summaries, summarizedUpTo, compactionVersion }`.
     *
     * Most turns: a no-op returning `{}` — the token check is cheap (no LLM call).
     * Fire-and-forget on failure: a compaction error must never abort a turn (the raw
     * history is still intact; the next turn will retry). Returns `{}` on error.
     */
    const compactionNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      // Back-compat: see llmNode comment — effectiveSummaries treats a legacy `summary` string
      // as [summary] so a previously-compacted thread isn't re-cut from 0 on the next pass.
      // On the first new-style compaction pass, `summaries` is seeded from effectiveSummaries
      // and the thread auto-upgrades; future passes use state.summaries directly.
      const effectiveSummaries =
        state.summaries.length > 0
          ? state.summaries
          : state.summarizedUpTo > 0 && state.summary
            ? [state.summary]
            : [];
      const from = effectiveSummaries.length > 0 ? state.summarizedUpTo : 0;
      const tailTokens = sumMessageTokens(state.messages.slice(from));
      if (tailTokens <= COMPACTION_TRIGGER_TOKENS) return {}; // strict: "exceeds" → not at-threshold

      const cutPoint = findCompactionCutPoint(
        state.messages,
        from,
        VERBATIM_BUFFER_TOKENS,
      );
      if (cutPoint <= from) return {}; // nothing to compact / pair-safety backstop

      try {
        const toSummarize = state.messages.slice(from, cutPoint);
        // Render the compaction window as a readable transcript (tool results omitted —
        // they are bulky and already compressed by compactPriorToolResults in live context).
        const transcript = toSummarize
          .flatMap((m): string[] => {
            const type = m.getType();
            if (type === 'human') {
              const text = flattenContent(m.content).trim();
              return text ? [`User: ${text}`] : [];
            }
            if (type === 'ai') {
              const lines: string[] = [];
              const text = flattenContent(m.content).trim();
              if (text) lines.push(`${bot.name}: ${text}`);
              const calls = (m as AIMessage).tool_calls ?? [];
              if (calls.length) {
                lines.push(
                  `${bot.name}: [used tools: ${calls.map((c) => c.name).join(', ')}]`,
                );
              }
              return lines;
            }
            return [];
          })
          .join('\n');

        if (!transcript.trim()) return {};

        // Prepend only the most recent existing summary for continuity (not the full queue)
        // so the model summarizes ONLY the new messages, not the already-summarised past.
        const previousSummarySection =
          effectiveSummaries.length > 0
            ? `Previous summary (earlier conversation context — do NOT re-summarize; use only for continuity):\n${effectiveSummaries[effectiveSummaries.length - 1]}\n\n`
            : '';
        const prompt = `You are summarizing a conversation for ${bot.name} (${bot.role}).

${previousSummarySection}Messages to summarize:
${transcript}

Write a rolling summary covering:
- Current state: what has been established, decided, or accomplished
- Work in progress: ongoing tasks and active efforts
- Key decisions and important facts learned
- Open items and next steps

Be thorough but concise. Preserve specific names, project names, technical details, and numeric references that matter for future context. Aim for ≤ ${MAX_SUMMARY_TOKENS} tokens (~${MAX_SUMMARY_TOKENS * 4} chars).`;

        const model = this.models.buildModel();
        const result = await model.invoke([new HumanMessage(prompt)], config);
        let newSummary = flattenContent(result.content).trim();
        if (!newSummary) return {};

        // Hard backstop: truncate with ellipsis if the model exceeded the token cap.
        const charCap = MAX_SUMMARY_TOKENS * 4;
        if (newSummary.length > charCap) {
          newSummary = newSummary.slice(0, charCap) + '…';
        }

        // FIFO queue: append new summary, evict oldest if over the limit.
        // Seed from effectiveSummaries so a legacy checkpoint's `summary` string becomes entry 0.
        const summaries = [...effectiveSummaries, newSummary];
        if (summaries.length > MAX_SUMMARIES) summaries.shift();

        const nextVersion = (state.compactionVersion ?? 0) + 1;
        const threadId =
          (config.configurable?.thread_id as string | undefined) ?? 'unknown';

        // Persist audit row — fire-and-forget (a store failure must not abort the turn).
        if (this.compactionStore) {
          this.compactionStore
            .record(threadId, nextVersion, cutPoint, newSummary)
            .catch((err) =>
              this.logger.warn(
                `compaction audit record failed (thread=${threadId}): ${err}`,
              ),
            );
        }

        this.logger.debug(
          `compaction ${bot.name} thread=${threadId} v${nextVersion} covered_up_to=${cutPoint} (${toSummarize.length} msgs summarized, summaries=${summaries.length})`,
        );
        return {
          summaries,
          summarizedUpTo: cutPoint,
          compactionVersion: nextVersion,
        };
      } catch (err) {
        // Fire-and-forget: a compaction failure is non-fatal; the raw history is still intact.
        this.logger.warn(`compaction failed for ${bot.name}: ${err}`);
        return {};
      }
    };

    return {
      gate: gateNode,
      consume: consumeNode,
      route,
      recall: recallNode,
      llm: llmNode,
      tools: toolsNode,
      toolLoopGuard: toolLoopGuardNode,
      reconcile: reconcileNode,
      compact: compactionNode,
      refresh: REFRESH,
      refreshContext: refreshContextNode,
    };
  }
}
