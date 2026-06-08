import { Spinner, TextInput } from '@inkjs/ui';
import { AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useState } from 'react';
import { getGraph } from '../chat.js';
import { MessageView, type Turn } from './components.js';

export function App() {
  const { exit } = useApp();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partial, setPartial] = useState('');
  const [busy, setBusy] = useState(false);

  // Ctrl+C exits by default (Ink). Also exit on Ctrl+D.
  useInput((_input, key) => {
    if (key.ctrl && _input === 'd') exit();
  });

  async function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text === '/exit' || text === '/quit') {
      exit();
      return;
    }

    setTurns((prev) => [...prev, { id: Date.now(), role: 'user', text }]);
    setBusy(true);
    setPartial('');

    let acc = '';
    try {
      const stream = await getGraph().stream(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: '1' }, streamMode: 'messages' },
      );
      for await (const [chunk] of stream) {
        if (chunk instanceof AIMessageChunk && typeof chunk.content === 'string') {
          acc += chunk.content;
          setPartial(acc);
        }
      }
      setTurns((prev) => [...prev, { id: Date.now() + 1, role: 'assistant', text: acc }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTurns((prev) => [...prev, { id: Date.now() + 1, role: 'error', text: message }]);
    } finally {
      setBusy(false);
      setPartial('');
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={turns}>{(turn) => <MessageView key={turn.id} turn={turn} />}</Static>

      {busy ? (
        <Box flexDirection="column">
          {partial ? <Text>{partial}</Text> : null}
          <Box>
            <Spinner label="thinking…" />
          </Box>
        </Box>
      ) : (
        <Box>
          <Text color="cyan">{'❯ '}</Text>
          {/* Remounted fresh each idle period (unmounted while busy), so it clears after each send. */}
          <TextInput placeholder="Type a message  (/exit to quit)" onSubmit={handleSubmit} />
        </Box>
      )}
    </Box>
  );
}
