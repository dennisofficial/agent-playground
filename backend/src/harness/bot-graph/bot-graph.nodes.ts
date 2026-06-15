import { EnvService } from '@core/config/env/env.service';
import { dispatchCustomEvent } from '@langchain/core/callbacks/dispatch';
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
import { getIdentity } from '../domain/identity';
import { flattenContent } from '../domain/text';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { GateService } from '../gate/gate.service';
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
import { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
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
  interleavedTeammates,
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
  if (Array.isArray(value))
    return `[${value.map(stableStringify).join(',')}]`;
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
 * The node IMPLEMENTATIONS of a bot's turn-graph — gate, loop_guard, recall, llm, tools,
 * mark_seen, pause, reconcile. `BotGraphFactory` owns the DI + the graph TOPOLOGY (which node goes
 * where); this owns what each node DOES. `forBot(bot)` returns the per-bot node functions plus the
 * bot's terminal-tool set (which `makeAfterTools` in routing.ts closes over).
 *
 * Constructed manually by the factory (not a Nest provider) so the factory keeps its existing
 * constructor — the services it injects are handed straight through here.
 */
export class BotGraphNodes {
  private readonly logger = new Logger(BotGraphNodes.name);
  private readonly gapThresholdMs: number;
  /** DORMANCY: master switch + the consecutive-soft-ignore count at which a bot goes dormant. */
  private readonly dormancyEnabled: boolean;
  private readonly dormancyThreshold: number;
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
    private readonly sessions: SessionRegistry,
    gapThresholdMs: number,
    dormancyEnabled = true,
    dormancyThreshold = 3,
    private readonly engineTools?: EngineToolFactory,
    private readonly compactionStore?: CompactionSummaryStore,
    private readonly toolLoopGuard?: ToolLoopGuardService,
  ) {
    this.gapThresholdMs = gapThresholdMs;
    this.dormancyEnabled = dormancyEnabled;
    this.dormancyThreshold = dormancyThreshold;
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

  /** Build the per-bot node functions + terminal-tool set for the turn graph. */
  forBot(bot: EmployeeDefinition) {
    const channel = this.channel;
    const allowlist = bot.tools ?? DEFAULT_CHAT_TOOLSET;
    const tools = this.toolRegistry.toStructuredTools(allowlist);
    // Turn-ending tools, derived from the allowlist's `terminal` flags (no magic-string list). Only
    // can't-fail tools should be terminal: the conductor surfaces only assistant text, never
    // tool-result content, so a swallowed failure from a fallible terminal tool would be invisible.
    const terminal = this.toolRegistry.terminalToolNames(allowlist);
    // Tool-triggered CAPABILITIES (e.g. Nora's deep_research) bind here at graph-build, alongside the
    // static allowlist and under the same cache_control breakpoint. Each opens a session, so it's
    // terminal like create_session. (Absent in unit specs where engineTools isn't injected.)
    if (this.engineTools) {
      const cap = this.engineTools.buildTools(bot, this.persona.context());
      tools.push(...cap.tools);
      for (const name of cap.terminalNames) terminal.add(name);
    }
    // Context-refreshing tools: name → scopes map, derived from the allowlist's `refreshesContext`
    // flags. Used by `makeAfterTools` (routing) and `refreshContextNode` (recompute).
    const REFRESH = this.toolRegistry.refreshScopesByName(allowlist);
    const refreshScopesFromTurn = makeRefreshScopesFromTurn(REFRESH);

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
      // `dormantSkip` resets here too (same trap: a stale `true` would skip reconcile next turn).
      const rtr = {
        draft: undefined,
        draftUsage: undefined,
        revisionPasses: 0,
        dormantSkip: false,
        // TOOL-LOOP guard per-turn reset (same trap as the rest: annotation defaults don't
        // re-apply on an existing thread, so a stale verdict/correction-count/instruction would
        // poison the next turn's `llm ⇄ tools` loop).
        toolLoopVerdict: undefined,
        toolLoopCorrections: 0,
        toolLoopInstruction: undefined,
        forcedRefreshScopes: undefined,
      };
      // DORMANCY accumulator (per (bot, room), via the checkpoint). Carried forward UNCHANGED on
      // the no-soft-call paths below; the gated path recomputes it. Written explicitly on every
      // path — annotation defaults only cover never-written threads.
      const softIgnores = state.consecutiveSoftIgnores ?? 0;
      // A no-LLM gate decision leaves no generation in the trace, so mark it with a point-in-time
      // Langfuse event nested under this `gate` span (via the handler's handleCustomEvent). `debug`
      // demotes it below the default view for the high-frequency idle case. Best-effort: never block.
      const traceGate = (
        action: string,
        reason: string,
        debug = false,
      ): Promise<void> =>
        dispatchCustomEvent(
          'gate.decision',
          { action, reason },
          debug
            ? { ...config, tags: [...(config.tags ?? []), 'langsmith:hidden'] }
            : config,
        );
      if (state.forced) {
        await traceGate('respond', 'forced');
        return {
          decision: 'respond',
          pending: [],
          turnStart,
          ...rtr,
          consecutiveSoftIgnores: 0, // a forced respond re-engages the bot
          lastContextTokens: 0, // no gate call on the forced path
        }; // job relay: skip the gate
      }
      const channelId = this.channelIdOf(config);
      const batch = channel
        .since(state.cursor, channelId)
        .filter((m) => m.authorBotId !== bot.id);
      if (batch.length === 0) {
        await traceGate('ignore', 'no-batch', true);
        return {
          decision: 'ignore',
          pending: [],
          turnStart,
          ...rtr,
          consecutiveSoftIgnores: softIgnores,
          lastContextTokens: 0, // no gate call when batch is empty
        }; // nothing for me
      }
      const latest = batch[batch.length - 1];
      const capped = !!config.configurable?.capped;
      if (capped && latest.authorBotId) {
        await traceGate('ignore', 'capped-loopbreak');
        return {
          decision: 'ignore',
          pending: batch,
          turnStart,
          ...rtr,
          consecutiveSoftIgnores: softIgnores,
          lastContextTokens: 0, // no gate call on the capped loop-breaker path
        }; // loop breaker
      }
      const room = this.channelRegistry.get(channelId);
      const dormant =
        this.dormancyEnabled && softIgnores >= this.dormancyThreshold;
      const d = await this.gateService.gate(
        bot,
        latest.text,
        {
          authorBotId: latest.authorBotId,
          authorName: latest.author,
          history: this.historyBefore(latest.seq, channelId),
          channel: room
            ? { kind: room.kind, name: room.displayName }
            : undefined,
          // The WHOLE unconsumed batch — a hail buried behind a teammate's faster reply still hard-fires.
          batch: batch.map((m) => ({
            text: m.text,
            authorBotId: m.authorBotId,
          })),
          dormant,
        },
        config,
      );
      // No LLM ran (a hard addressing rule or dormant-skip decided it) → mark the gate span. The soft
      // path already shows its Haiku generation, so don't double-record it.
      if (!d.softGate)
        await traceGate(d.action, d.reason ?? 'hard-rule', d.action === 'ignore');
      // Next dormancy count: a respond/ack re-engages (→0); a SOFT ignore advances toward dormancy
      // (+1); a cheap dormant-skip or hard-rule ignore leaves it unchanged.
      const nextSoftIgnores =
        d.action !== 'ignore' ? 0 : d.softGate ? softIgnores + 1 : softIgnores;
      // reasoning + gateUsage ride the delta so the conductor can emit them (debug only).
      return {
        decision: d.action,
        ackEmoji: d.emoji,
        // Fire the transient "composing" 💭 the moment we commit to responding — surfaced before
        // recall/llm/tools run, and REMOVED by the conductor when the turn ends (so present =
        // composing now, gone = replied). Only on a real gated respond; the forced path returned above.
        reaction: d.action === 'respond' ? '💭' : undefined,
        reactionTargetId: latest.id,
        reasoning: d.reasoning,
        gateUsage: d.usage,
        lastContextTokens: d.usage?.input ?? 0,
        pending: batch,
        turnStart,
        ...rtr,
        consecutiveSoftIgnores: nextSoftIgnores,
        dormantSkip: !!d.dormantSkip, // overrides rtr's false on the cheap-ignore path
      };
    };

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
        ? dropLeadingOrphanToolResults(state.messages.slice(state.summarizedUpTo))
        : state.messages;
      const history = filterToolDispatchMessages(
        compactPriorToolResults(
          repairDanglingToolCalls(rawHistory),
        ),
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
                  .map((s, i) => `[Summary ${i + 1}/${effectiveSummaries.length}]\n${s}`)
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
      // Only a FINAL text post is gated: a tool-call step must enter history intact (a tool_use
      // needs its tool_result) and the post-tools llm step folds new messages in anyway.
      const interleaved =
        hasToolCalls || !aiText
          ? []
          : interleavedTeammates(channel, channelId, newCursor, bot.id);
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

    // ── Recursion guard constants ──────────────────────────────────────────────────────────────────
    /** Minimum number of the bot's own AI messages in history before the guard is worth running. A
     * shorter history can't show a meaningful repetition pattern — skip to avoid false positives. */
    const GUARD_FLOOR = 6;
    /** The first-person pause message emitted when a loop is confirmed. Used as both the pause-node
     * payload and the anti-spam sentinel (startsWith check so future rewording stays consistent). */
    const PAUSE_TEXT =
      "I think I'm going in circles here — pausing so I don't spin. Ping me when you want me to pick this back up.";
    const PAUSE_SENTINEL = "I think I'm going in circles here";

    /**
     * LOOP_GUARD NODE — decide whether the bot is stuck in a no-progress loop.
     *
     * Runs on the respond path between `gate` and `recall`. Returns `{ loopBreak: true }` when a
     * loop is detected; the conditional edge `afterGuard` routes to `pause` instead of `recall`.
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
     *   - last SPOKEN AI message is already the pause sentinel (anti break-spam: once paused, the
     *     guard re-arms only after the bot says something substantive again)
     *   - fewer than GUARD_FLOOR substantive SPOKEN own messages in history (not enough signal)
     *
     * The judged window counts only SPOKEN messages (non-empty chat text). A tool-only turn —
     * gate passed, but the employee used a tool and ended its turn silently via end_turn — posts
     * no chat text and is never loop evidence; it's a deliberate "second gate" decline, not a
     * stall. (Without this, a quiet teammate woken by bot-only chatter accumulates identical
     * empty-text "Name: [tools: list_sessions]" lines that the judge reads as a no-progress loop.)
     *
     * The judged window also EXCLUDES prior pause lines: the breaker's own output must never count
     * as loop evidence — a pause-polluted window otherwise re-confirms "looping" forever (observed:
     * eight consecutive self-confirming re-fires).
     */
    /** The skip verdict — clears any checkpointed break from a prior turn (see docstring). */
    const GUARD_SKIP: Partial<BotStateType> = {
      loopBreak: false,
      guardReasoning: undefined,
    };
    const loopGuardNode = async (
      state: BotStateType,
      config: RunnableConfig,
    ): Promise<Partial<BotStateType>> => {
      if (state.forced) return GUARD_SKIP;
      if (!this.recursionGuard.isEnabled()) return GUARD_SKIP;
      // Only fire on bot-authored triggers — human messages don't form bot loops
      const latest = state.pending[state.pending.length - 1];
      if (!latest?.authorBotId) return GUARD_SKIP;
      // A human anywhere in the batch → real turn, no fuse check.
      if (state.pending.some((m) => !m.authorBotId)) return GUARD_SKIP;
      const ownMessages = state.messages.filter((m) => m.getType() === 'ai');
      // Only the bot's SPOKEN messages are loop evidence. A tool-only turn (gate passed, but the
      // employee used a tool and ended its turn silently via end_turn) is a deliberate "second
      // gate" decline, not a stall — it must not count toward the floor or appear in the window.
      const spoken = ownMessages.filter(
        (m) => flattenContent(m.content).trim() !== '',
      );
      // Anti break-spam: once paused, stay paused on bot-only chatter; the guard re-arms when the
      // bot next SPEAKS a substantive (non-pause) message of its own.
      const lastSpoken = spoken.length
        ? flattenContent(spoken[spoken.length - 1].content).trim()
        : '';
      if (lastSpoken.startsWith(PAUSE_SENTINEL)) return GUARD_SKIP;
      // Need enough SUBSTANTIVE history for a meaningful window — pause lines don't count.
      const substantive = spoken.filter(
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
      const result = await this.recursionGuard.detect(bot, windowText, config);
      return {
        loopBreak: result.looping,
        guardReasoning: result.reasoning,
      };
    };

    /**
     * PAUSE NODE — end the turn cleanly when a loop is confirmed.
     *
     * Mirrors `markSeenNode`: consumes the pending batch (records the triggering messages in
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
    const pauseNode = (
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
        context: { work: '', memory: '', tasks: '' },
        recallQuery: '',
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

    /** Record the gated batch in the checkpoint without a model call (the ack/ignore path). */
    const markSeenNode = (
      state: BotStateType,
      config: RunnableConfig,
    ): Partial<BotStateType> => {
      const pending = state.pending;
      const newCursor = pending.length
        ? pending[pending.length - 1].seq + 1
        : channel.lengthOf(this.channelIdOf(config));
      // recalled, context, and recallQuery are all reset here — this path skips `recall`, and
      // un-cleared values would ride the checkpoint as a stale recall until the next respond.
      return {
        messages: pending.map(asInput),
        cursor: newCursor,
        recalled: '',
        context: { work: '', memory: '', tasks: '' },
        recallQuery: '',
      };
    };

    /**
     * REFRESH_CONTEXT NODE — recompute only the context slices dirtied by the just-run tool batch.
     *
     * Runs between `tools` and `llm` when a state-mutating tool call ran (create/remove_worktree,
     * close_session, remember/update_memory/forget, add/complete_task). Only the flagged scopes are
     * re-fetched — a memory-only refresh doesn't re-list worktrees, and vice-versa. Detection is
     * name-based (same posture as terminal): a failed mutation still triggers a harmless, idempotent
     * recompute. Errors degrade silently, keeping the previous slice intact.
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
     * boundaries, not mid-turn tool calls). Sits only on the NON-TERMINAL continuation path
     * (`makeAfterTools` routes terminal batches straight to reconcile/llm).
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
        return { toolLoopVerdict: 'pass', toolLoopReasoning: decision.reasoning };
      // stuck
      const corrections = state.toolLoopCorrections ?? 0;
      if (corrections === 0) {
        const scopes = [
          ...((REFRESH.get(tripped.call.name) ?? []) as readonly RefreshScope[]),
        ];
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
     * Trigger: block 3 estimated tokens ≥ COMPACTION_TRIGGER_TOKENS. Estimation uses
     * Math.ceil(chars / 4) — fast, no tokenizer dependency.
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
      if (tailTokens < COMPACTION_TRIGGER_TOKENS) return {};

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
      loopGuard: loopGuardNode,
      recall: recallNode,
      llm: llmNode,
      tools: toolsNode,
      toolLoopGuard: toolLoopGuardNode,
      markSeen: markSeenNode,
      pause: pauseNode,
      reconcile: reconcileNode,
      compact: compactionNode,
      terminal,
      refresh: REFRESH,
      refreshContext: refreshContextNode,
    };
  }
}
