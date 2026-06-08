import { Spinner, TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer } from 'react';
import { conductor } from '../conductor.js';
import { BOT } from '../persona.js';
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
    // "/as <name>" switches who you're speaking as in the channel — lets you simulate a group chat.
    const as = text.match(/^\/as\s+(.+)$/i);
    if (as) {
      conductor.setSpeaker(as[1]);
      return;
    }
    conductor.submitUser(text);
  }

  const { history, liveTools, liveText, busy, ctx, running, speaker } = conductor.getState();
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
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
        <Box key={item.id} flexDirection="column" marginBottom={1}>
          <Text color="green" bold>
            {BOT.name}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      ))}
      {liveTools.map((item) => (
        <MessageView key={item.id} item={item} />
      ))}

      {busy ? (
        <Box>
          <Spinner label={`${BOT.name} is thinking…`} />
        </Box>
      ) : (
        <Box>
          <Text color="cyan">{`${who} ❯ `}</Text>
          <TextInput
            placeholder="message   ·   /as <name> to switch speaker   ·   /exit"
            onSubmit={handleSubmit}
          />
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
