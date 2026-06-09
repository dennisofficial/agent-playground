import { Spinner, TextInput } from '@inkjs/ui';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { memo, useEffect, useReducer, useRef } from 'react';
import { conductor } from '../conductor.js';
import { ROSTER } from '../employees/index.js';
import { logBus } from '../logbus.js';
import { type CommandContext, runCommand } from './commands/index.js';
import { MessageView } from './components.js';
import { renderEvent } from './messages.js';
import { initStore, storeReducer, type Viewport } from './store.js';

/** The startup header, rendered as the first transcript item (not a stray stdout write before Ink mounts). */
const BANNER =
  `#dev — ${ROSTER.map((b) => `${b.name} (${b.role})`).join(' · ')}\n` +
  '/as <name> to speak as someone   ·   @Name to address a bot   ·   /exit';

// The live tail re-renders on every status tick (spinner/ctx). Items are immutable — a new object only on
// add/patch — so memoizing by the `item` prop skips re-rendering (and re-parsing markdown for) unchanged rows.
const Row = memo(MessageView);

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // The transcript is a KEYED store: events/log-records become items we `add` or `react`-patch by id, and a
  // settled prefix flushes to scrollback (see store.ts). It holds all UI state now — the conductor holds none.
  const [store, dispatch] = useReducer(
    storeReducer,
    initStore([{ id: 'banner', kind: 'note', text: BANNER }]),
  );
  // Status (busy/thinking/ctx/jobs-running/speaker) is a pull snapshot — re-render when it changes.
  const [, force] = useReducer((x: number) => x + 1, 0);

  // The live terminal size, used to bound the dynamic (un-settled) region to ≈ one screen. Read live each
  // dispatch (stdout is a stable stream), so a resize is picked up on the next item.
  const viewport = (): Viewport => ({
    rows: Math.max(6, (stdout.rows ?? 40) - 8), // reserve ~8 lines for spinner/awaiting/input/footer
    cols: stdout.columns ?? 80,
  });

  useEffect(() => {
    const offStatus = conductor.subscribe(force);
    const offEvents = conductor.onEvent((e) => {
      if (e.kind === 'reaction') {
        // Fold onto the target message node; the store falls back to a standalone row if it's already settled.
        dispatch({
          t: 'react',
          id: e.id,
          targetId: e.targetId,
          by: e.botName,
          emoji: e.emoji,
          vp: viewport(),
        });
      } else {
        dispatch({ t: 'add', item: renderEvent(e), vp: viewport() });
      }
    });
    // Observability that used to tear the render via stderr now arrives here as keyed debug nodes.
    const offLog = logBus.subscribe((r) =>
      dispatch({
        t: 'add',
        item: { id: r.id, kind: r.kind, by: r.by, text: r.text },
        vp: viewport(),
      }),
    );
    return () => {
      offStatus();
      offEvents();
      offLog();
    };
    // stdout is stable; viewport reads it live, so the subscriptions never need to re-bind.
  }, [stdout]);

  // The input stays mounted (so you can type while bots think); bump this key to remount it empty after send.
  const [inputKey, clearInput] = useReducer((x: number) => x + 1, 0);
  // Ids for the TUI's own local rows (slash-command output) — namespaced so they can't collide with
  // conductor/log-bus event ids.
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
    // handles it. The context is the only UI seam they get — note() adds a local transcript item, exit() quits.
    const cmdCtx: CommandContext = {
      note: (t) =>
        dispatch({ t: 'add', item: { id: localId(), kind: 'note', text: t }, vp: viewport() }),
      exit,
    };
    if (runCommand(text, cmdCtx)) {
      clearInput();
      return;
    }
    // Not a command → put it on the channel. The conductor emits it back through the event stream (keyed by
    // the channel id), so it renders via the same path as everything else — no local echo.
    conductor.submitUser(text);
    clearInput();
  }

  const ctxLabel =
    ctx.input !== undefined
      ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out`
      : '';

  const settled = store.items.slice(0, store.settledCount);
  const live = store.items.slice(store.settledCount);

  return (
    <Box flexDirection="column">
      {/* Settled items flush to native scrollback exactly once (Ink <Static> draws each new prefix row a
          single time). The live tail below re-renders every update, so a reaction can fold into its message. */}
      <Static items={settled}>{(item) => <Row key={item.id} item={item} />}</Static>
      <Box flexDirection="column">
        {live.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </Box>

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
