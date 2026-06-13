import { EnvService } from '@core/config/env/env.service';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { ChannelRegistryService } from '../channel/channel-registry.service';
import { ChannelService } from '../channel/channel.service';
import { getIdentity } from '../domain/identity';
import { flattenContent } from '../domain/text';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { GateService } from '../gate/gate.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { FetchService } from '../memory/fetch.service';
import { ConsolidationService } from '../memory/consolidation.service';
import { ReconcileService } from '../memory/reconcile.service';
import { RecursionGuardService } from '../recursion-guard/recursion-guard.service';
import {
  SESSION_REGISTRY,
  type SessionRegistry,
} from '../sessions/session-registry.port';
import { DEFAULT_CHAT_TOOLSET } from '../tools/default-toolset';
import { ToolRegistry } from '../tools/tool.registry';
import { WorktreeService } from '../worktrees/worktree.service';
import {
  GAP_THRESHOLD_DEFAULT_MS,
  buildTimeContext,
  withDividers,
} from './channel-render';
import type { BotStateType } from './bot-state';
import {
  asInput,
  repairDanglingToolCalls,
  usageOf,
  withCacheBreakpoint,
} from './message-helpers';
import {
  MAX_REVISION_PASSES,
  interleavedTeammates,
  revisionNote,
} from './read-the-room';

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
  private readonly gapThresholdMs: number;
  private readonly consolidationWindow: number;

  constructor(
    private readonly channel: ChannelService,
    private readonly channelRegistry: ChannelRegistryService,
    private readonly toolRegistry: ToolRegistry,
    private readonly gateService: GateService,
    private readonly recursionGuard: RecursionGuardService,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly consolidation: ConsolidationService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    private readonly worktrees: WorktreeService,
    private readonly sessions: SessionRegistry,
    gapThresholdMs: number,
    consolidationWindow: number,
  ) {
    this.gapThresholdMs = gapThresholdMs;
    this.consolidationWindow = consolidationWindow;
  }

  /**
   * The recent room window fed to the async consolidation pass — the last N messages, oldest first.
   * Teammate (AI) lines are tagged "(teammate)" so the consolidation prompt can extract from the
   * humans only; humans render as "Name: text". Unlike `turnTranscript` (one turn's slice), this is
   * the WHOLE recent window — consolidation deliberates over full context, not a fragment.
   */
  private consolidationWindowText(channelId: string): string {
    return this.channel
      .snapshot(channelId)
      .slice(-this.consolidationWindow)
      .map((m) =>
        m.authorBotId
          ? `(teammate) ${m.author}: ${m.text}`
          : `${m.author}: ${m.text}`,
      )
      .join('\n');
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
        },
        config,
      );
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
        pending: batch,
        turnStart,
        ...rtr,
      };
    };

    /** The pre-LLM read: fetch the facts + open tasks relevant to what's being said into `recalled`. */
    const recallNode = async (
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
     * RECONCILE NODE — the single post-turn write, reached on every path (respond, ack/ignore,
     * pause). It reconciles the reminders/board plate (add/complete/drop) against the turn's
     * transcript INLINE, then SCHEDULES durable-fact consolidation off the hot path.
     *
     * Durable-FACT auto-capture replaces the old inline reconcileMemory call, which was disabled
     * (Dennis, 2026-06-12) for being too credulous — reacting to one turn's fragment, it stored
     * anticipatory chatter ("ready to execute when the standup closes") as accomplished fact. The
     * successor is the DEBOUNCED ConsolidationService: `schedule` only (re)arms a timer (no-op when
     * MEMORY_CONSOLIDATION_ENABLED is off, and never blocks the turn); once the room goes quiet a
     * single hardened pass runs over the whole recent window. Tasks stay inline (cheap, per-turn).
     */
    const reconcileNode = async (
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
          config,
        );
      // Off the hot path: debounced durable-fact consolidation over the full recent room window.
      this.consolidation.schedule(
        bot,
        getIdentity(config),
        this.consolidationWindowText(this.channelIdOf(config)),
      );
      return {};
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
      // recalled is reset here too — this path skips `recall`, and an un-cleared value would ride
      // the checkpoint as a stale recall (deleted reminder ids included) until the next respond.
      return {
        messages: pending.map(asInput),
        cursor: newCursor,
        recalled: '',
      };
    };

    return {
      gate: gateNode,
      loopGuard: loopGuardNode,
      recall: recallNode,
      llm: llmNode,
      tools: toolsNode,
      markSeen: markSeenNode,
      pause: pauseNode,
      reconcile: reconcileNode,
      terminal,
    };
  }
}
