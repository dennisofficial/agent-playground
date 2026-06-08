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
import { buildModel } from './model.js';
import { chatPromptFor } from './persona.js';
import { type Bot, botById, ROSTER } from './roster.js';

/**
 * A bot's TURN, as an explicit LangGraph state machine (the user's vision: nodes you can see, trace, and
 * add/remove). One graph per bot, persisted on thread `${bot.id}:dev:root`. The dispatcher invokes it
 * whenever the channel has grown past the bot's cursor.
 *
 *   START → gate ─┬─ respond → llm ⇄ tools ─→ END
 *                 └─ acknowledge / ignore → consume → END
 *
 * (acknowledge differs from ignore only in that the gate also emits an emoji, which the dispatcher
 * renders as a reaction from the gate node's streamed delta; both then just record-and-drain.)
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
  /** Debug only: the soft gate's one-line rationale, surfaced inline in the TUI. Absent for hard rules. */
  reasoning?: string;
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
  /** The non-own batch the gate decided on — consumed by `consume` on the ack/ignore path. */
  pending: Annotation<ChannelMsg[]>({
    reducer: (_: ChannelMsg[], b: ChannelMsg[]) => b ?? [],
    default: () => [],
  }),
});

type BotStateType = typeof BotState.State;

/** Channel message → a `Speaker: text` HumanMessage (how a bot reads what others said). */
const asInput = (m: ChannelMsg): HumanMessage => new HumanMessage(`${m.author}: ${m.text}`);

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
    if (state.forced) return { decision: 'respond', pending: [] }; // job relay: skip the gate
    const batch = channel.since(state.cursor).filter((m) => m.authorBotId !== bot.id);
    if (batch.length === 0) return { decision: 'ignore', pending: [] }; // nothing for me → drain & end
    const latest = batch[batch.length - 1];
    const capped = !!config.configurable?.capped;
    if (capped && latest.authorBotId) return { decision: 'ignore', pending: batch }; // loop breaker
    const d = await gate(bot, latest.text, {
      authorBotId: latest.authorBotId,
      authorName: latest.author,
      history: historyBefore(latest.seq),
    });
    // `reasoning` rides the delta so the dispatcher can render it inline (debug only; hard rules omit it).
    return { decision: d.action, ackEmoji: d.emoji, reasoning: d.reasoning, pending: batch };
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
    const convo = [new SystemMessage(chatPromptFor(bot)), ...state.messages, ...injected];
    const ai = await model.invoke(convo, config);
    return { messages: [...injected, ai], cursor: newCursor };
  };

  const toolsNode = new ToolNode(CHAT_TOOLS);

  /** Record the gated batch in the checkpoint without a model call (the ack/ignore path), advance cursor. */
  const consumeNode = (state: BotStateType): Partial<BotStateType> => {
    const pending = state.pending;
    const newCursor = pending.length ? pending[pending.length - 1].seq + 1 : channel.length;
    return { messages: pending.map(asInput), cursor: newCursor };
  };

  const route = (state: BotStateType): 'llm' | 'consume' =>
    state.decision === 'respond' ? 'llm' : 'consume';

  const afterLlm = (state: BotStateType): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1] as AIMessage | undefined;
    return last?.tool_calls?.length ? 'tools' : END;
  };

  const graph = new StateGraph(BotState)
    .addNode('gate', gateNode)
    .addNode('llm', llmNode)
    .addNode('tools', toolsNode)
    .addNode('consume', consumeNode)
    .addEdge(START, 'gate')
    .addConditionalEdges('gate', route, ['llm', 'consume'])
    .addConditionalEdges('llm', afterLlm, ['tools', END])
    .addEdge('tools', 'llm')
    .addEdge('consume', END)
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
