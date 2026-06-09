import {
  type AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, END, messagesStateReducer, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { channel, type ChannelMsg } from './channel.js';
import { CHAT_TOOLS } from './chat.js';
import { gate } from './gate.js';
import { getCheckpointer } from './memory/checkpointer.js';
import { fetchContext } from './memory/fetch.js';
import { getIdentity } from './memory/identity.js';
import { reconcileMemory, reconcileTasks } from './memory/reconcile.js';
import { buildModel } from './model.js';
import { chatPromptFor } from './persona.js';
import { type Bot, botById, ROSTER } from './roster.js';

/**
 * A bot's TURN, as an explicit LangGraph state machine (the user's vision: nodes you can see, trace, and
 * add/remove). One graph per bot, persisted on thread `${bot.id}:dev:root`. The dispatcher invokes it
 * whenever the channel has grown past the bot's cursor.
 *
 *   START → gate ─┬─ respond → fetch → llm ⇄ tools ─┐
 *                 └─ acknowledge / ignore → consume ─┴→ reconcile-memory ∥ reconcile-task → END
 *
 * Memory is DETERMINISTIC, not agentic: `fetch` reads the relevant facts + open tasks IN before the bot
 * thinks (so it always walks in knowing, instead of hoping the llm calls `recall`), and the two parallel
 * `reconcile` nodes write memory/tasks OUT after — on EVERY path, so the bot reflects on every turn it
 * saw. The llm keeps its memory/task tools too; reconcile is the state-aware backstop on top of them.
 * (acknowledge differs from ignore only in that the gate also emits an emoji, which the dispatcher
 * renders as a reaction from the gate node's streamed delta; both then record-drain-and-reconcile.)
 *
 * THE HEART (mid-thought collaboration): the `llm` node consumes `channel.since(cursor)` at the TOP of
 * EVERY step, so a teammate's message that lands WHILE this bot is looping is folded into its very next
 * model call. Per-turn injection would only see messages between turns; this sees them between steps.
 *
 * Cursor coordinate note — READ BEFORE "FIXING" THE CURSOR: the `cursor` field rides in graph state ONLY
 * so it threads across `llm` steps within a single run. It is INTENTIONALLY overwritten every invocation
 * from the dispatcher's in-memory cursor (passed as input). The persisted value is dead. This is load-
 * bearing: the channel is in-memory and restarts at seq 0, while the checkpoint persists; if we trusted
 * the persisted cursor (e.g. 42) against a fresh channel (seq 0..n), `channel.since(42)` would return
 * nothing and the bot would go deaf until the channel caught up. So the dispatcher owns the cursor's
 * coordinate space; the graph only borrows it for within-run threading.
 */

/** What the dispatcher reads out of a node's streamed delta (a partial of BotState). */
export type GateAction = 'respond' | 'acknowledge' | 'ignore';

export interface BotStateDelta {
  messages?: BaseMessage[];
  cursor?: number;
  decision?: GateAction;
  ackEmoji?: string;
  /** The pre-LLM fetch's `recalled` block — the dispatcher renders a `recall` row from it. */
  recalled?: string;
  /** Debug only: the soft gate's one-line rationale, surfaced inline in the TUI. Absent for hard rules. */
  reasoning?: string;
  /** Debug only: token usage for this turn's gate call, surfaced inline in the TUI. Absent for hard rules. */
  gateUsage?: { input: number; output: number };
}

const BotState = Annotation.Root({
  /** The bot's persisted conversation (the real, durable history). */
  messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  /** Delivered-up-to seq. Overwritten from the dispatcher each run (see header). */
  cursor: Annotation<number>({ reducer: (_: number, b: number) => b ?? 0, default: () => 0 }),
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
  /** Ack emoji, surfaced by the `react` node when the gate said acknowledge. */
  ackEmoji: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: the soft gate's rationale this turn, surfaced inline by the dispatcher (like ackEmoji). */
  reasoning: Annotation<string | undefined>({
    reducer: (_: unknown, b: string | undefined) => b,
    default: () => undefined,
  }),
  /** Debug only: token usage for this turn's gate call, surfaced inline by the dispatcher. */
  gateUsage: Annotation<{ input: number; output: number } | undefined>({
    reducer: (_: unknown, b: { input: number; output: number } | undefined) => b,
    default: () => undefined,
  }),
  /** The non-own batch the gate decided on — consumed by `consume` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({
    reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [],
    default: () => [],
  }),
  /** Ephemeral pre-LLM memory context (the `fetch` node's output). Re-injected each llm call like the
   * persona, NEVER written into `messages`, so it doesn't accumulate in history. Always overwritten by
   * `fetch` (to '' when empty) so a stale recall can't linger. */
  recalled: Annotation<string>({ reducer: (_: string, b: string) => b ?? '', default: () => '' }),
  /** `messages.length` at the start of this turn (set by `gate`), so reconcile can slice just this
   * turn's exchange out of the full persisted history. */
  turnStart: Annotation<number>({ reducer: (_: number, b: number) => b ?? 0, default: () => 0 }),
});

type BotStateType = typeof BotState.State;

/** Channel message → a `Speaker: text` HumanMessage (how a bot reads what others said). */
const asInput = (m: ChannelMsg): HumanMessage => new HumanMessage(`${m.author}: ${m.text}`);

/** Flatten message content (string | content blocks) to plain text. */
const flat = (c: BaseMessage['content']): string =>
  typeof c === 'string'
    ? c
    : c
        .map((p) =>
          typeof p === 'string' ? p : 'text' in p && typeof p.text === 'string' ? p.text : '',
        )
        .join('');

/**
 * The conversation up to (but NOT including) `seq` — the last `n` messages, oldest first — for the gate
 * to read. A generous window is what lets the gate tell "this is an ongoing human↔teammate thread I
 * should stay out of" from "an open question I should answer."
 */
const historyBefore = (seq: number, n = 16): string =>
  channel
    .snapshot()
    .filter((m) => m.seq < seq)
    .slice(-n)
    .map((m) => `${m.author}: ${m.text}`)
    .join('\n');

function buildBotGraph(bot: Bot) {
  const model = buildModel().bindTools(CHAT_TOOLS);

  /** Peek the channel (read-only — never touches messages/cursor) and pick respond/acknowledge/ignore. */
  const gateNode = async (
    state: BotStateType,
    config: RunnableConfig,
  ): Promise<Partial<BotStateType>> => {
    // Mark where this turn's messages begin, so the reconcile nodes can slice just this turn out of the
    // full persisted history (set on every path — reconcile runs on all of them).
    const turnStart = state.messages.length;
    if (state.forced) return { decision: 'respond', pending: [], turnStart }; // job relay: skip the gate
    const batch = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
    if (batch.length === 0) return { decision: 'ignore', pending: [], turnStart }; // nothing for me
    const latest = batch[batch.length - 1];
    const capped = !!config.configurable?.capped;
    if (capped && latest.authorBotId) return { decision: 'ignore', pending: batch, turnStart }; // loop breaker
    const d = await gate(bot, latest.text, {
      authorBotId: latest.authorBotId,
      authorName: latest.author,
      history: historyBefore(latest.seq),
    });
    // reasoning + gateUsage ride the delta so the dispatcher can render them inline (debug only).
    return {
      decision: d.action,
      ackEmoji: d.emoji,
      reasoning: d.reasoning,
      gateUsage: d.usage,
      pending: batch,
      turnStart,
    };
  };

  /** The pre-LLM read: fetch the facts + open tasks relevant to what's being said into `recalled`. */
  const fetchNode = async (
    state: BotStateType,
    config: RunnableConfig,
  ): Promise<Partial<BotStateType>> => {
    const fresh = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
    const query = fresh.map((m) => `${m.author}: ${m.text}`).join('\n');
    // Always set recalled (to '' when empty) so a stale recall from a prior turn never lingers.
    return { recalled: await fetchContext(bot, query, getIdentity(config)) };
  };

  /**
   * Consume `channel.since(cursor)` at the TOP (the mid-thought injection), call the model, and commit
   * the new messages + the model's reply + the advanced cursor in ONE atomic checkpoint. A throw here
   * commits nothing, so a retry re-reads the same messages — no loss, no double.
   */
  const llmNode = async (
    state: BotStateType,
    config: RunnableConfig,
  ): Promise<Partial<BotStateType>> => {
    const fresh = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
    const newCursor = channel.length; // own/gap messages are skipped but the cursor still moves past them
    const injected = fresh.map(asInput);
    // Message order is chosen for PROMPT CACHING (a prefix match — any byte change invalidates everything
    // after it; render order is tools → system → messages):
    //   1. persona system prompt — frozen, the stable head of the cacheable prefix
    //   2. durable history — append-only, so the prefix grows but never rewrites
    //   3. recalled memory — VOLATILE (re-retrieved each turn), so it must come AFTER the history, never in
    //      the system block. In the system block it would (a) bust the whole prefix every turn and (b) be a
    //      second SystemMessage, which langchain-anthropic rejects ("System messages are only permitted as
    //      the first passed message" — it keeps just messages[0] as system). As a tail user-turn preamble it
    //      does neither. Like the persona, it's re-injected each call and never persisted into `messages`.
    //   4. this turn's new channel messages.
    // No cache_control breakpoint is set yet, so nothing is cached today regardless — see note to enable it.
    const convo = [
      new SystemMessage(chatPromptFor(bot)),
      ...state.messages,
      ...(state.recalled
        ? [new HumanMessage(`(Relevant memory — for your reference:\n${state.recalled})`)]
        : []),
      ...injected,
    ];
    const ai = await model.invoke(convo, config);
    return { messages: [...injected, ai], cursor: newCursor };
  };

  const toolsNode = new ToolNode(CHAT_TOOLS);

  /** This turn's exchange — the messages added since `gate` marked `turnStart`, with tool-result/internal
   * plumbing filtered out (human messages + the bot's own text replies only) — fed to the reconcile passes. */
  const turnTranscript = (state: BotStateType): string =>
    state.messages
      .slice(state.turnStart)
      .filter((m) => m.getType() === 'human' || (m.getType() === 'ai' && flat(m.content).trim()))
      .map((m) =>
        m.getType() === 'ai' ? `${bot.name}: ${flat(m.content).trim()}` : flat(m.content).trim(),
      )
      .join('\n');

  /** The post-LLM write: reconcile durable facts (add/update/delete) against the turn. */
  const reconcileMemoryNode = async (
    state: BotStateType,
    config: RunnableConfig,
  ): Promise<Partial<BotStateType>> => {
    const transcript = turnTranscript(state);
    if (transcript.trim()) await reconcileMemory(bot, transcript, getIdentity(config));
    return {};
  };

  /** The post-LLM write: reconcile the task board (add/complete/drop) against the turn. */
  const reconcileTaskNode = async (
    state: BotStateType,
    config: RunnableConfig,
  ): Promise<Partial<BotStateType>> => {
    const transcript = turnTranscript(state);
    if (transcript.trim()) await reconcileTasks(bot, transcript, getIdentity(config));
    return {};
  };

  /** Record the gated batch in the checkpoint without a model call (the ack/ignore path), advance cursor. */
  const consumeNode = (state: BotStateType): Partial<BotStateType> => {
    const pending = state.pending;
    const newCursor = pending.length ? pending[pending.length - 1].seq + 1 : channel.length;
    return { messages: pending.map(asInput), cursor: newCursor };
  };

  const route = (state: BotStateType): 'fetch' | 'consume' =>
    state.decision === 'respond' ? 'fetch' : 'consume';

  // When the llm loop is done, fan out to BOTH reconcile nodes (they run in parallel, then join at END).
  const RECONCILE: ['reconcileMemory', 'reconcileTask'] = ['reconcileMemory', 'reconcileTask'];
  const afterLlm = (state: BotStateType): 'tools' | string[] => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    return last?.tool_calls?.length ? 'tools' : RECONCILE;
  };

  const graph = new StateGraph(BotState)
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
    .addEdge('tools', 'llm')
    .addEdge('consume', 'reconcileMemory')
    .addEdge('consume', 'reconcileTask')
    .addEdge('reconcileMemory', END)
    .addEdge('reconcileTask', END)
    .compile({ checkpointer: getCheckpointer() });

  return graph;
}

// One compiled graph per bot, lazy + memoized (buildModel needs ANTHROPIC_API_KEY at first use).
const graphs = new Map<string, ReturnType<typeof buildBotGraph>>();

export function getBotGraph(botId: string): ReturnType<typeof buildBotGraph> {
  let g = graphs.get(botId);
  if (!g) {
    g = buildBotGraph(botById(botId) ?? ROSTER[0]);
    graphs.set(botId, g);
  }
  return g;
}
