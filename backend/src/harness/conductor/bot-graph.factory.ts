import { type AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { Inject, Injectable } from '@nestjs/common';
import { ChannelService } from '../channel/channel.service';
import type { ChannelMsg } from '../channel/channel.types';
import type { GateAction } from '../domain/conductor-events';
import { getIdentity } from '../domain/identity';
import { flattenContent } from '../domain/text';
import type { EmployeeDefinition } from '../employees/employee.types';
import { PersonaService } from '../employees/persona.service';
import { GateService } from '../gate/gate.service';
import { ChatModelFactory } from '../llm/chat-model.factory';
import { FetchService } from '../memory/fetch.service';
import { CHECKPOINTER } from '../memory/memory.module';
import { ReconcileService } from '../memory/reconcile.service';
import { DEFAULT_CHAT_TOOLSET } from '../tools/default-toolset';
import { ToolRegistry } from '../tools/tool.registry';

/**
 * A bot's TURN, as an explicit LangGraph state machine. One graph per bot, persisted on thread
 * `${bot.id}:${project}:root` (Postgres checkpointer). The conductor invokes it whenever the channel
 * has grown past the bot's cursor.
 *
 *   START → gate ─┬─ respond → fetch → llm ⇄ tools ─┐
 *                 └─ acknowledge / ignore → consume ─┴→ reconcile-memory ∥ reconcile-task → END
 *
 * Memory is DETERMINISTIC, not agentic: `fetch` reads the relevant facts + open tasks IN before the
 * bot thinks, and the two parallel `reconcile` nodes write memory/tasks OUT after — on EVERY path.
 * The llm keeps its memory/task tools too; reconcile is the state-aware backstop on top of them.
 *
 * THE HEART (mid-thought collaboration): the `llm` node consumes `channel.since(cursor)` at the TOP
 * of EVERY step, so a teammate's message that lands WHILE this bot is looping is folded into its
 * very next model call.
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
}

const BotState = Annotation.Root({
  /** The bot's persisted conversation (the real, durable history). */
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  /** Delivered-up-to seq. Overwritten from the conductor each run (see header). */
  cursor: Annotation<number>({ reducer: (_: number, b: number) => b ?? 0, default: () => 0 }),
  /** Forces the respond path, gate-bypassed — used for job relays (a seeded synthetic message). */
  forced: Annotation<boolean>({ reducer: (_: boolean, b: boolean) => b ?? false, default: () => false }),
  /** Gate verdict for this turn (drives the conditional edge out of `gate`). */
  decision: Annotation<GateAction>({
    reducer: (_: GateAction, b: GateAction) => b ?? 'ignore',
    default: () => 'ignore',
  }),
  /** Ack emoji, surfaced when the gate said acknowledge. */
  ackEmoji: Annotation<string | undefined>({ reducer: (_: unknown, b: string | undefined) => b, default: () => undefined }),
  /** The "seen, working" reaction the gate emits the moment it commits to a (non-forced) respond. */
  reaction: Annotation<string | undefined>({ reducer: (_: unknown, b: string | undefined) => b, default: () => undefined }),
  /** The channel-message id this turn's reaction is on (the gated message). */
  reactionTargetId: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: the soft gate's rationale this turn. */
  reasoning: Annotation<string | undefined>({ reducer: (_: unknown, b: string | undefined) => b, default: () => undefined }),
  /** Debug only: token usage for this turn's gate call. */
  gateUsage: Annotation<{ input: number; output: number } | undefined>({
    reducer: (_: unknown, b: { input: number; output: number } | undefined) => b,
    default: () => undefined,
  }),
  /** The non-own batch the gate decided on — consumed by `consume` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({ reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [], default: () => [] }),
  /** Ephemeral pre-LLM memory context (the `fetch` node's output). Re-injected each llm call like
   * the persona, NEVER written into `messages`. Always overwritten by `fetch` (to '' when empty). */
  recalled: Annotation<string>({ reducer: (_: string, b: string) => b ?? '', default: () => '' }),
  /** `messages.length` at the start of this turn (set by `gate`), so reconcile can slice just this
   * turn's exchange out of the full persisted history. */
  turnStart: Annotation<number>({ reducer: (_: number, b: number) => b ?? 0, default: () => 0 }),
});

type BotStateType = typeof BotState.State;

/** Channel message → a `Speaker: text` HumanMessage (how a bot reads what others said). */
const asInput = (m: ChannelMsg): HumanMessage => new HumanMessage(`${m.author}: ${m.text}`);

/**
 * A shallow copy of `m` with a cache breakpoint on its last content block — WITHOUT mutating the
 * original (it rides in checkpointed state, so a mutation would poison the durable history). Only
 * anchors on human/ai turns carrying cacheable text; other turns fall back to system-only caching.
 */
const withCacheBreakpoint = (m: BaseMessage): BaseMessage => {
  const kind = m.getType();
  if (kind !== 'human' && kind !== 'ai') return m;
  const cc = { type: 'ephemeral', ttl: '1h' } as const;
  const clone = (content: unknown): BaseMessage => {
    const Ctor = m.constructor as unknown as new (fields: unknown) => BaseMessage;
    return new Ctor({ ...m, content });
  };
  if (typeof m.content === 'string') {
    return m.content.trim() ? clone([{ type: 'text', text: m.content, cache_control: cc }]) : m;
  }
  const last = m.content.length - 1;
  return last >= 0 ? clone(m.content.map((b, i) => (i === last ? { ...b, cache_control: cc } : b))) : m;
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
            content: '(no result recorded — the turn was interrupted before this tool finished)',
          }),
      ),
    );
  }
  return repaired ?? history;
};

@Injectable()
export class BotGraphFactory {
  // One compiled graph per bot, lazy + memoized (buildModel needs ANTHROPIC_API_KEY at first use).
  private graphs = new Map<string, ReturnType<BotGraphFactory['build']>>();

  constructor(
    private readonly channel: ChannelService,
    private readonly toolRegistry: ToolRegistry,
    private readonly gateService: GateService,
    private readonly fetchService: FetchService,
    private readonly reconcile: ReconcileService,
    private readonly models: ChatModelFactory,
    private readonly persona: PersonaService,
    @Inject(CHECKPOINTER) private readonly checkpointer: PostgresSaver,
  ) {}

  getBotGraph(bot: EmployeeDefinition) {
    let g = this.graphs.get(bot.id);
    if (!g) {
      g = this.build(bot);
      this.graphs.set(bot.id, g);
    }
    return g;
  }

  /**
   * The conversation up to (but NOT including) `seq` — the last `n` messages, oldest first — for the
   * gate to read. A generous window is what lets the gate tell "an ongoing human↔teammate thread I
   * should stay out of" from "an open question I should answer."
   */
  private historyBefore(seq: number, n = 16): string {
    return this.channel
      .snapshot()
      .filter((m) => m.seq < seq)
      .slice(-n)
      .map((m) => `${m.author}: ${m.text}`)
      .join('\n');
  }

  private build(bot: EmployeeDefinition) {
    const channel = this.channel;
    const allowlist = bot.tools ?? DEFAULT_CHAT_TOOLSET;
    const tools = this.toolRegistry.toStructuredTools(allowlist);
    // Turn-ending tools, derived from the allowlist's `terminal` flags (no magic-string list). Only
    // can't-fail tools should be terminal: the conductor surfaces only assistant text, never
    // tool-result content, so a swallowed failure from a fallible terminal tool would be invisible.
    const TERMINAL = this.toolRegistry.terminalToolNames(allowlist);
    const model = this.models.buildModel().bindTools(tools);

    /** Peek the channel (read-only — never touches messages/cursor) and pick respond/ack/ignore. */
    const gateNode = async (state: BotStateType, config: RunnableConfig): Promise<Partial<BotStateType>> => {
      // Mark where this turn's messages begin, so the reconcile nodes can slice just this turn out
      // of the full persisted history (set on every path — reconcile runs on all of them).
      const turnStart = state.messages.length;
      if (state.forced) return { decision: 'respond', pending: [], turnStart }; // job relay: skip the gate
      const batch = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
      if (batch.length === 0) return { decision: 'ignore', pending: [], turnStart }; // nothing for me
      const latest = batch[batch.length - 1];
      const capped = !!config.configurable?.capped;
      if (capped && latest.authorBotId) return { decision: 'ignore', pending: batch, turnStart }; // loop breaker
      const d = await this.gateService.gate(bot, latest.text, {
        authorBotId: latest.authorBotId,
        authorName: latest.author,
        history: this.historyBefore(latest.seq),
      });
      // reasoning + gateUsage ride the delta so the conductor can emit them (debug only).
      return {
        decision: d.action,
        ackEmoji: d.emoji,
        // Fire the "seen, working" 👀 the moment we commit to responding — surfaced before
        // fetch/LLM/tools run. Only on a real gated respond; the forced path returned above.
        reaction: d.action === 'respond' ? '👀' : undefined,
        reactionTargetId: latest.id,
        reasoning: d.reasoning,
        gateUsage: d.usage,
        pending: batch,
        turnStart,
      };
    };

    /** The pre-LLM read: fetch the facts + open tasks relevant to what's being said into `recalled`. */
    const fetchNode = async (state: BotStateType, config: RunnableConfig): Promise<Partial<BotStateType>> => {
      const fresh = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
      const freshText = fresh.map((m) => `${m.author}: ${m.text}`).join('\n');
      // Enrich the retrieval query with a few lines of prior context so a THIN turn ("sounds good")
      // doesn't embed to noise. The tail is query-only — it shapes retrieval, never what's stored.
      const priorTail = fresh.length ? this.historyBefore(fresh[0].seq, 3) : '';
      const query = [priorTail, freshText].filter((s) => s.trim()).join('\n');
      // Always set recalled (to '' when empty) so a stale recall from a prior turn never lingers.
      return { recalled: await this.fetchService.fetchContext(bot, query, getIdentity(config)) };
    };

    /**
     * Consume `channel.since(cursor)` at the TOP (the mid-thought injection), call the model, and
     * commit the new messages + the model's reply + the advanced cursor in ONE atomic checkpoint.
     * A throw here commits nothing, so a retry re-reads the same messages — no loss, no double.
     */
    const llmNode = async (state: BotStateType, config: RunnableConfig): Promise<Partial<BotStateType>> => {
      const fresh = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
      const newCursor = channel.length; // own/gap messages are skipped but the cursor still moves past them
      const injected = fresh.map(asInput);
      // Message order is chosen for PROMPT CACHING (a prefix match — any byte change invalidates
      // everything after it; render order is tools → system → messages):
      //   1. persona system prompt — frozen; the breakpoint caches bound tools + persona.
      //   2. durable history — append-only; a SECOND breakpoint rides on the last history message
      //      (cloned, never mutating the checkpointed one).
      //   3. recalled memory — VOLATILE (re-retrieved each turn), so it must come AFTER the history,
      //      never in the system block (it would bust the prefix every turn, and langchain-anthropic
      //      rejects a second SystemMessage). Re-injected each call, never persisted into `messages`.
      //   4. this turn's new channel messages.
      const history = repairDanglingToolCalls(state.messages);
      const cachedHistory = history.length
        ? [...history.slice(0, -1), withCacheBreakpoint(history[history.length - 1])]
        : history;
      const convo = [
        new SystemMessage({
          content: [
            { type: 'text', text: this.persona.chatPromptFor(bot), cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        }),
        ...cachedHistory,
        ...(state.recalled ? [new HumanMessage(`(Relevant memory — for your reference:\n${state.recalled})`)] : []),
        ...injected,
      ];
      const ai = await model.invoke(convo, config);
      return { messages: [...injected, ai], cursor: newCursor };
    };

    const toolsNode = new ToolNode(tools);

    /** A compact note of a turn-ending action worth reconciling against (a dispatched job is a
     * commitment being acted on), else undefined. Tool RESULTS stay hidden. */
    const toolActionNote = (m: AIMessage): string | undefined => {
      const tasks = (m.tool_calls ?? [])
        .filter((c) => c.name === 'dispatch_job')
        .map((c) => (typeof c.args?.task === 'string' ? c.args.task : ''))
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

    /** The post-LLM write: reconcile durable facts (add/update/delete) against the turn. */
    const reconcileMemoryNode = async (state: BotStateType, config: RunnableConfig): Promise<Partial<BotStateType>> => {
      const transcript = turnTranscript(state);
      // Tag the reconcile with this turn's gate verdict, so the session metric can separate writes
      // made on the respond path from those a silent (acknowledge/ignore) bot makes.
      if (transcript.trim()) await this.reconcile.reconcileMemory(bot, transcript, getIdentity(config), state.decision);
      return {};
    };

    /** The post-LLM write: reconcile the reminders plate (add/complete/drop) against the turn. */
    const reconcileTaskNode = async (state: BotStateType, config: RunnableConfig): Promise<Partial<BotStateType>> => {
      const transcript = turnTranscript(state);
      if (transcript.trim()) await this.reconcile.reconcileTasks(bot, transcript, getIdentity(config), state.decision);
      return {};
    };

    /** Record the gated batch in the checkpoint without a model call (the ack/ignore path). */
    const consumeNode = (state: BotStateType): Partial<BotStateType> => {
      const pending = state.pending;
      const newCursor = pending.length ? pending[pending.length - 1].seq + 1 : channel.length;
      return { messages: pending.map(asInput), cursor: newCursor };
    };

    const route = (state: BotStateType): 'fetch' | 'consume' => (state.decision === 'respond' ? 'fetch' : 'consume');

    // When the llm loop is done, fan out to BOTH reconcile nodes (parallel, then join at END).
    const RECONCILE: ['reconcileMemory', 'reconcileTask'] = ['reconcileMemory', 'reconcileTask'];
    const afterLlm = (state: BotStateType): 'tools' | string[] => {
      const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
      return last?.tool_calls?.length ? 'tools' : RECONCILE;
    };

    // After tools run, END the turn (skip the loop back to `llm` that would otherwise force a chatty
    // text-only follow-up) when EVERY call in the triggering message is terminal. `every` (not
    // `some`) is load-bearing: a message mixing a terminal tool with an informational or FALLIBLE
    // one loops back so that result is relayed.
    const afterTools = (state: BotStateType): 'llm' | string[] => {
      const lastAi = [...state.messages].reverse().find((m) => m.getType() === 'ai') as AIMessage | undefined;
      const calls = lastAi?.tool_calls ?? [];
      const allTerminal = calls.length > 0 && calls.every((c) => TERMINAL.has(c.name));
      return allTerminal ? RECONCILE : 'llm';
    };

    return new StateGraph(BotState)
      .addNode('gate', gateNode)
      .addNode('fetch', fetchNode)
      .addNode('llm', llmNode)
      .addNode('tools', toolsNode)
      .addNode('consume', consumeNode)
      .addNode('reconcileMemory', reconcileMemoryNode)
      .addNode('reconcileTask', reconcileTaskNode)
      .addEdge(START, 'gate')
      .addConditionalEdges('gate', route, ['fetch', 'consume'])
      .addEdge('fetch', 'llm')
      .addConditionalEdges('llm', afterLlm, ['tools', 'reconcileMemory', 'reconcileTask'])
      .addConditionalEdges('tools', afterTools, ['llm', 'reconcileMemory', 'reconcileTask'])
      .addEdge('consume', 'reconcileMemory')
      .addEdge('consume', 'reconcileTask')
      .addEdge('reconcileMemory', END)
      .addEdge('reconcileTask', END)
      .compile({ checkpointer: this.checkpointer });
  }
}
