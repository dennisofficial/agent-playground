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
    // "/as <name>" switches who you're speaking as in the channel — lets you simulate a group chat.
    const as = text.match(/^\/as\s+(.+)$/i);
    if (as) {
      conductor.setSpeaker(as[1]);
      return;
    }
    conductor.submitUser(text);
  }

  const { history, ctx, running, speaker, thinking } = conductor.getState();
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  const ctxLabel =
    ctx.input !== undefined
      ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out`
      : '';

  return (
    <Box flexDirection="column">
      {/* Completed messages stream into history at the MESSAGE level (streamMode 'updates'): each
          chunk of a bot's turn — text or tool calls — appears whole as soon as that step finishes,
          not token-by-token. The spinner below shows the bot is still working between chunks. */}
      <Static items={history}>{(item) => <MessageView key={item.id} item={item} />}</Static>

      {/* Running-bots indicator — separate from the input, which stays live so you can type while they
          think and fire messages as you go (they fold them in at their next step). */}
      {thinking.length > 0 && (
        <Box>
          <Spinner label={`${thinking.join(', ')} ${thinking.length === 1 ? 'is' : 'are'} thinking…`} />
        </Box>
      )}
      <Box>
        <Text color="cyan">{`${who} ❯ `}</Text>
        <TextInput
          placeholder="message   ·   /as <name> to switch speaker   ·   /exit"
          onSubmit={handleSubmit}
        />
      </Box>

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
