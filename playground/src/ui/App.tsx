import { Spinner, TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { conductor } from '../conductor.js';
import { type CommandContext, runCommand } from './commands/index.js';
import { MessageView } from './components.js';
import { type RenderItem, renderEvent } from './messages.js';

/** A short HH:MM:SS stamp for the user's own echoed messages (the conductor stamps bot events). */
const clock = (): string =>
  new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

const appendHistory = (state: RenderItem[], item: RenderItem): RenderItem[] => [...state, item];

export function App() {
  const { exit } = useApp();
  // The conductor's domain events accumulate into our own render history (it holds no UI state now).
  const [history, pushHistory] = useReducer(appendHistory, []);
  // Status (busy/thinking/ctx/jobs-running/speaker) is a pull snapshot — re-render when it changes.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const offStatus = conductor.subscribe(force);
    const offEvents = conductor.onEvent((e) => pushHistory(renderEvent(e)));
    return () => {
      offStatus();
      offEvents();
    };
  }, []);
  // The input stays mounted now (so you can type while bots think), so it no longer clears itself on
  // submit — bump this key to remount it empty after each send.
  const [inputKey, clearInput] = useReducer((x: number) => x + 1, 0);
  // Ids for the TUI's own local rows (the echoed user input, /tasks output) — namespaced so they can't
  // collide with conductor-emitted event ids.
  const localSeq = useRef(0);
  const localId = () => `local-${localSeq.current++}`;

  useInput((input, key) => {
    if (key.ctrl && input === 'd') exit();
  });

  const { ctx, running, speaker, thinking } = conductor.getStatus();
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  // Plan jobs waiting on the human's /approve. Re-read each render — the status subscription fires on
  // every job update, so this panel appears the moment a plan lands in 'awaiting'.
  const awaiting = conductor.awaitingApprovals();

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    // Slash-commands live in ./commands as a registry of plugins; the first one that recognizes `text`
    // handles it. This context is the only UI seam they get — note() prints a local transcript row, exit()
    // quits. Everything else (conductor/board/tasks) they import directly. (Named cmdCtx to avoid shadowing
    // the `ctx` context-usage snapshot above.)
    const cmdCtx: CommandContext = {
      note: (t) => pushHistory({ id: localId(), kind: 'note', text: t }),
      exit,
    };
    if (runCommand(text, cmdCtx)) {
      clearInput();
      return;
    }
    // Not a command → echo the user's own message locally (the conductor only puts it on the channel),
    // then submit it to the channel.
    pushHistory({ id: localId(), kind: 'user', text, speaker: who, ts: clock() });
    conductor.submitUser(text);
    clearInput();
  }

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
          <Spinner
            label={`${thinking.join(', ')} ${thinking.length === 1 ? 'is' : 'are'} thinking…`}
          />
        </Box>
      )}
      {awaiting.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {awaiting.map((j) => (
            <Text key={j.id} color="yellow">
              {`⏳ Awaiting your approval: ${j.id} ("${j.task.slice(0, 60)}${
                j.task.length > 60 ? '…' : ''
              }")  ·  /approve ${j.id}  ·  /reject ${j.id} <reason>`}
            </Text>
          ))}
        </Box>
      )}
      <Box>
        <Text color="cyan">{`${who} ❯ `}</Text>
        <TextInput
          key={inputKey}
          placeholder="message   ·   /approve <job>   ·   /tasks   ·   /as <name>   ·   /exit"
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
