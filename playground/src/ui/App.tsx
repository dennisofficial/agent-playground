import { Spinner, TextInput } from '@inkjs/ui';
import { Box, type DOMElement, measureElement, Text, useApp, useInput, useWindowSize } from 'ink';
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { conductor } from '../conductor.js';
import { ROSTER } from '../employees/index.js';
import { logBus } from '../logbus.js';
import { type CommandContext, runCommand } from './commands/index.js';
import { MessageView } from './components.js';
import { isDebug, renderEvent } from './messages.js';
import { storeReducer } from './store.js';
import { sessionDump, toPlainText } from './transcript.js';

/** The startup header, rendered as the first transcript item (not a stray stdout write). */
const BANNER =
  `#dev — ${ROSTER.map((b) => `${b.name} (${b.role})`).join(' · ')}\n` +
  '/as <name> · @Name to address a bot · /debug logs · ↑/↓/wheel + PgUp/PgDn scroll · /exit';

// Memoized so the live frame re-rendering on every status tick doesn't re-parse markdown for unchanged rows.
const Row = memo(MessageView);

export function App() {
  const { exit } = useApp();
  const size = useWindowSize(); // { columns, rows } — re-renders on terminal resize

  // The transcript: a flat keyed store. We own the screen (alternate buffer), so EVERY item is retained;
  // we render a LINE-scrolled window of them. Nothing is flushed to native scrollback.
  const [items, dispatch] = useReducer(storeReducer, [
    { id: 'banner', kind: 'note', text: BANNER },
  ]);
  const [, force] = useReducer((x: number) => x + 1, 0); // status (spinner/footer) re-render

  const [showDebug, setShowDebug] = useState(false); // default off = "pure Slack" view
  const visible = useMemo(
    () => items.filter((it) => showDebug || !isDebug(it)),
    [items, showDebug],
  );

  // LINE-accurate scroll. measureElement is clamped on the clipped container itself, but per-ITEM heights
  // measure correctly (even items taller than the viewport), so we sum them for the true content height `C`
  // and scroll by line `offset` via marginTop on the content column (flex-start: messages fill from the top
  // and stick to the bottom once they overflow). `follow` keeps us pinned to the newest line.
  const viewRef = useRef<DOMElement>(null);
  const itemEls = useRef(new Map<string, DOMElement>());
  const [dims, setDims] = useState({ H: 0, C: 0 });
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(true);
  const maxOffset = Math.max(0, dims.C - dims.H);

  // Measure after layout (measureElement reads computed Yoga heights, so this is cheap — no relayout).
  useEffect(() => {
    const H = viewRef.current ? measureElement(viewRef.current).height : 0;
    let C = 0;
    for (const it of visible) {
      const el = itemEls.current.get(it.id);
      if (el) C += measureElement(el).height;
    }
    setDims((d) => (d.H === H && d.C === C ? d : { H, C }));
  }, [visible, size.columns, size.rows]);

  // Re-pin to the bottom when following and content grew; otherwise clamp so a stale offset (e.g. after
  // hiding debug shrinks the content) can't strand the viewport past the end.
  useEffect(() => {
    setOffset((o) => (follow ? maxOffset : Math.min(o, maxOffset)));
  }, [maxOffset, follow]);

  const scrollByLines = (delta: number): void => {
    const next = Math.max(0, Math.min(maxOffset, offset + delta));
    setOffset(next);
    setFollow(next >= maxOffset); // back at the newest line ⇒ resume following
  };

  useEffect(() => {
    const onEvent = conductor.onEvent((e) => {
      if (e.kind === 'reaction') {
        dispatch({ t: 'react', id: e.id, targetId: e.targetId, by: e.botName, emoji: e.emoji });
      } else {
        dispatch({ t: 'add', item: renderEvent(e) });
      }
    });
    const offLog = logBus.subscribe((r) =>
      dispatch({ t: 'add', item: { id: r.id, kind: r.kind, by: r.by, text: r.text } }),
    );
    const offStatus = conductor.subscribe(force);
    return () => {
      onEvent();
      offLog();
      offStatus();
    };
  }, []);

  const [inputKey, clearInput] = useReducer((x: number) => x + 1, 0);
  const localSeq = useRef(0);
  const localId = () => `local-${localSeq.current++}`;

  // Quit: stash the FULL transcript (debug included) so index.tsx can print it to the restored screen — the
  // alternate buffer has no native scrollback, so this is how the conversation survives the session.
  const exitApp = (): void => {
    sessionDump.text = items.map(toPlainText).join('\n');
    exit();
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'd') return exitApp();
    const page = Math.max(1, dims.H - 1);
    if (key.pageUp) return scrollByLines(-page);
    if (key.pageDown) return scrollByLines(page);
    // Plain ↑/↓ scroll one line: the @inkjs/ui input ignores them, and in the alternate screen most
    // terminals (iTerm2, Terminal.app) translate the MOUSE WHEEL into ↑/↓ — so this is wheel scroll too,
    // with no mouse-tracking takeover (text selection keeps working).
    if (key.upArrow) return scrollByLines(-1);
    if (key.downArrow) return scrollByLines(1);
  });

  const { ctx, running, speaker, thinking } = conductor.getStatus();
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);
  const awaiting = conductor.awaitingApprovals();

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    const cmdCtx: CommandContext = {
      note: (t) => dispatch({ t: 'add', item: { id: localId(), kind: 'note', text: t } }),
      exit: exitApp,
      setDebug: (show) => {
        const next = show ?? !showDebug;
        setShowDebug(next);
        return next;
      },
    };
    if (runCommand(text, cmdCtx)) {
      clearInput();
      return;
    }
    conductor.submitUser(text);
    setFollow(true); // jump to the bottom to watch the reply land
    clearInput();
  }

  const ctxLabel =
    ctx.input !== undefined
      ? `ctx ${ctx.input.toLocaleString()} in · ${(ctx.output ?? 0).toLocaleString()} out`
      : '';
  const hiddenDebug = items.length - visible.length;
  const footer = [
    ctxLabel,
    running > 0 ? `${running} job${running === 1 ? '' : 's'} running` : '',
    offset < maxOffset ? '↑ scrolled · ↓/PgDn for latest' : '',
    hiddenDebug > 0 ? `${hiddenDebug} hidden · /debug` : '',
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Box flexDirection="column" height={size.rows}>
      {/* The scroll viewport: clips to its height; the content column is shifted up by `offset` LINES for
          line-accurate scrolling. The input sits OUTSIDE it, so it's always visible however far you scroll. */}
      <Box ref={viewRef} flexGrow={1} flexDirection="column" overflowY="hidden">
        <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
          {visible.map((item) => (
            <Box
              key={item.id}
              flexDirection="column"
              flexShrink={0}
              ref={(el: DOMElement | null) => {
                if (el) itemEls.current.set(item.id, el);
                else itemEls.current.delete(item.id);
              }}
            >
              <Row item={item} />
            </Box>
          ))}
        </Box>
      </Box>

      {thinking.length > 0 && (
        <Box flexShrink={0}>
          <Spinner
            label={`${thinking.join(', ')} ${thinking.length === 1 ? 'is' : 'are'} thinking…`}
          />
        </Box>
      )}
      {awaiting.length > 0 && (
        <Box flexDirection="column" flexShrink={0} marginBottom={1}>
          {awaiting.slice(0, 3).map((j) => (
            <Text key={j.id} color="yellow" wrap="truncate">
              {`⏳ Awaiting: ${j.id} ("${j.task.slice(0, 50)}${j.task.length > 50 ? '…' : ''}")  ·  /approve ${j.id}  ·  /reject ${j.id} <reason>`}
            </Text>
          ))}
          {awaiting.length > 3 && (
            <Text color="yellow" dimColor>{`  …and ${awaiting.length - 3} more awaiting`}</Text>
          )}
        </Box>
      )}
      <Box flexShrink={0}>
        <Text color="cyan">{`${who} ❯ `}</Text>
        <TextInput
          key={inputKey}
          placeholder="message   ·   /approve <job>   ·   /debug   ·   /tasks   ·   /exit"
          onSubmit={handleSubmit}
        />
      </Box>
      {footer && (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">
            {footer}
          </Text>
        </Box>
      )}
    </Box>
  );
}
