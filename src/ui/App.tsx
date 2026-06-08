import { Spinner, TextInput } from '@inkjs/ui';
import { AIMessageChunk, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { getGraph } from '../chat.js';
import { listJobs, onJobUpdate } from '../jobs.js';
import { MessageView } from './components.js';
import type { ContextUsage, RenderItem } from './messages.js';
import { toRenderItems } from './messages.js';

const THREAD_ID = 'zero:cli:main';

export function App() {
  const { exit } = useApp();
  const [history, setHistory] = useState<RenderItem[]>([]); // finalized rows (Static)
  const [live, setLive] = useState<RenderItem[]>([]); // the in-flight message, re-rendered as it streams
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<ContextUsage>({});
  const [running, setRunning] = useState(0);
  const seq = useRef(0);

  useInput((input, key) => {
    if (key.ctrl && input === 'd') exit();
  });

  // Background job lifecycle → notice rows + running count.
  useEffect(() => {
    return onJobUpdate((job) => {
      setRunning(listJobs().filter((j) => j.status === 'running').length);
      if (job.status === 'done') {
        const summary = (job.result ?? '').replace(/\s+/g, ' ').slice(0, 240);
        setHistory((p) => [...p, { id: `n-${seq.current++}`, kind: 'notice', text: `✓ ${job.id} finished: ${summary}` }]);
      } else if (job.status === 'failed') {
        setHistory((p) => [...p, { id: `n-${seq.current++}`, kind: 'notice', text: `⚠ ${job.id} failed: ${job.error ?? 'unknown error'}` }]);
      }
    });
  }, []);

  async function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text === '/exit' || text === '/quit') {
      exit();
      return;
    }

    // Commit the user's message to history immediately (instant echo, stays put).
    setHistory((p) => [...p, { id: `u-${seq.current++}`, kind: 'user', text }]);
    setBusy(true);
    setLive([]);

    // Finalize a streamed message: move its render rows into the static history.
    const commit = (msg: BaseMessage | undefined) => {
      if (!msg) return;
      const usage = (msg as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
      if (usage) setCtx({ input: usage.input_tokens, output: usage.output_tokens });
      const rows = toRenderItems([msg]);
      if (rows.length) setHistory((p) => [...p, ...rows]);
    };

    // Stream messages, accumulating chunks into real message objects (kept as messages, not a
    // flattened string). The in-flight message renders live; when the next message begins (or
    // the stream ends) the completed one moves to history. No reconcile, no flip-switch.
    let curId: string | undefined;
    let cur: BaseMessage | undefined;
    try {
      const stream = await getGraph().stream(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: THREAD_ID }, streamMode: 'messages', recursionLimit: 50 },
      );
      for await (const [chunk] of stream) {
        const id = chunk.id ?? curId ?? '_0';
        if (cur && id !== curId) {
          commit(cur); // previous message is complete → static history
          cur = chunk;
          curId = id;
        } else if (cur && cur instanceof AIMessageChunk && chunk instanceof AIMessageChunk) {
          cur = cur.concat(chunk); // merge chunks of the same message (text + tool calls + usage)
        } else {
          cur = chunk;
          curId = id;
        }
        setLive(toRenderItems([cur]));
      }
      commit(cur); // last message
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setHistory((p) => [...p, { id: `e-${seq.current++}`, kind: 'error', text: message }]);
    } finally {
      setLive([]);
      setBusy(false);
    }
  }

  const ctxLabel = ctx.input !== undefined ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out` : '';

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {live.map((item) => (
        <MessageView key={item.id} item={item} />
      ))}

      {busy ? (
        <Box>
          <Spinner label="thinking…" />
        </Box>
      ) : (
        <Box>
          <Text color="cyan">{'❯ '}</Text>
          <TextInput placeholder="Type a message  (/exit to quit)" onSubmit={handleSubmit} />
        </Box>
      )}

      {(ctxLabel || running > 0) && (
        <Box>
          <Text dimColor>
            {[ctxLabel, running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : ''].filter(Boolean).join('  ·  ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
