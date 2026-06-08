import { ChatAnthropic } from '@langchain/anthropic';
import { SystemMessage } from '@langchain/core/messages';
import { MemorySaver, MessagesAnnotation, StateGraph } from '@langchain/langgraph';

// Read injected vars. Treat ''/undefined as unset, but PRESERVE a valid 0 (e.g. CHAT_TEMPERATURE=0).
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

// Lazy + memoized: ChatAnthropic's constructor throws if ANTHROPIC_API_KEY is missing.
// Building the graph at module top-level would crash on import before Ink can render an
// error row — so construct it on first use, inside the App's submit try/catch.
let graph: ReturnType<typeof build> | undefined;

function build() {
  const temperature = num(process.env.CHAT_TEMPERATURE, 1);
  const maxTokens = Math.max(1, num(process.env.CHAT_MAX_TOKENS, 2048));
  const llm = new ChatAnthropic({
    model: 'claude-sonnet-4-6',
    maxTokens,
    temperature,
  });

  async function agent(state: typeof MessagesAnnotation.State) {
    const response = await llm.invoke([
      new SystemMessage('You are a helpful assistant in a command-line chat.'),
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', agent)
    .addEdge('__start__', 'agent')
    .compile({ checkpointer: new MemorySaver() });
}

export const getGraph = () => (graph ??= build());
