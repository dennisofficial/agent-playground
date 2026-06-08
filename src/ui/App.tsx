import { Spinner, TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer } from 'react';
import { conductor } from '../conductor.js';
import { MessageView } from './components.js';

export function App() {
  const { exit } = useApp();
  // The conductor is the single source of truth. Re-render whenever its state changes.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => conductor.subscribe(force), []);

  useInput((input, key) => {
    if (key.ctrl && input === 'd') exit();
  });

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    if (text === '/exit' || text === '/quit') {
      exit();
      return;
    }
    conductor.submitUser(text);
  }

  const { history, liveTools, liveText, busy, ctx, running } = conductor.getState();
  const ctxLabel =
    ctx.input !== undefined
      ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out`
      : '';

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {/* In-flight message: streaming text first (plain — partial markdown is broken mid-stream
          and marked-terminal's ANSI destabilizes Ink's line accounting), then its tool rows
          below. Both finalize to history via commit(), where text gets full markdown. */}
      {liveText.map((item) => (
        <Box key={item.id} marginBottom={1}>
          <Text>{item.text}</Text>
        </Box>
      ))}
      {liveTools.map((item) => (
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
            {[ctxLabel, running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : '']
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
