import type { ConductorEventsBus } from '@harness/conductor/conductor-events.bus';
import type { ConductorStatus } from '@harness/domain/conductor-events';
import type { DOMElement } from 'ink';
import { memo, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Box,
  measureElement,
  Spinner,
  Text,
  TextInput,
  useApp,
  useInput,
  useWindowSize,
} from '../ink';
import type { TuiChatSurface } from '../tui-chat-surface';
import { type Command, type CommandContext, runCommand } from './commands';
import { MessageView } from './components';
import { isDebug, renderEvent } from './messages';
import { storeReducer } from './store';
import { sessionDump, toPlainText } from './transcript';

/** Everything the App needs from the Nest container — resolved in main.ts and passed as props
 * (the component tree stays DI-free; only main.ts touches the container). */
export interface AppDeps {
  bus: ConductorEventsBus;
  surface: TuiChatSurface;
  commands: Command[];
  /** The startup banner (roster summary), composed in main.ts from the EmployeeRegistry. */
  banner: string;
}

// Memoized so the live frame re-rendering on every status tick doesn't re-parse markdown for unchanged rows.
const Row = memo(MessageView);

/** (Ported from playground/src/ui/App.tsx — conductor singletons became the `deps` props.) */
export function App({ deps }: { deps: AppDeps }) {
  const { exit } = useApp();
  const size = useWindowSize(); // { columns, rows } — re-renders on terminal resize

  // The transcript: a flat keyed store. We own the screen (alternate buffer), so EVERY item is
  // retained; we render a LINE-scrolled window of them. Nothing is flushed to native scrollback.
  const [items, dispatch] = useReducer(storeReducer, [
    { id: 'banner', kind: 'note', text: deps.banner },
  ]);
  const [status, setStatus] = useState<ConductorStatus>(deps.bus.status);

  const [showDebug, setShowDebug] = useState(false); // default off = "pure Slack" view
  // The focused room: chat rows from other rooms are retained but hidden (Slack's focused-channel
  // model). Rows without a channelId (notes, errors, debug) show everywhere.
  const [activeChannel, setActiveChannel] = useState(
    deps.surface.activeChannel,
  );
  const visible = useMemo(
    () =>
      items.filter(
        (it) =>
          (showDebug || !isDebug(it)) &&
          (!('channelId' in it) ||
            !it.channelId ||
            it.channelId === activeChannel),
      ),
    [items, showDebug, activeChannel],
  );

  // LINE-accurate scroll. Per-ITEM heights measure correctly (even items taller than the viewport),
  // so we sum them for the true content height `C` and scroll by line `offset` via marginTop on the
  // content column. `follow` keeps us pinned to the newest line.
  const viewRef = useRef<DOMElement>(null);
  const itemEls = useRef(new Map<string, DOMElement>());
  const [dims, setDims] = useState({ H: 0, C: 0 });
  const [offset, setOffset] = useState(0);
  const [follow, setFollow] = useState(true);
  const maxOffset = Math.max(0, dims.C - dims.H);

  // Measure after layout (measureElement reads computed Yoga heights — cheap, no relayout).
  useEffect(() => {
    const H = viewRef.current ? measureElement(viewRef.current).height : 0;
    let C = 0;
    for (const it of visible) {
      const el = itemEls.current.get(it.id);
      if (el) C += measureElement(el).height;
    }
    setDims((d) => (d.H === H && d.C === C ? d : { H, C }));
  }, [visible, size.columns, size.rows]);

  // Re-pin to the bottom when following and content grew; otherwise clamp so a stale offset can't
  // strand the viewport past the end.
  useEffect(() => {
    setOffset((o) => (follow ? maxOffset : Math.min(o, maxOffset)));
  }, [maxOffset, follow]);

  const scrollByLines = (delta: number): void => {
    const next = Math.max(0, Math.min(maxOffset, offset + delta));
    setOffset(next);
    setFollow(next >= maxOffset); // back at the newest line ⇒ resume following
  };

  useEffect(() => {
    const eventsSub = deps.bus.events$.subscribe((e) => {
      if (e.kind === 'reaction') {
        dispatch({
          t: 'react',
          id: e.id,
          targetId: e.targetId,
          by: e.botName,
          emoji: e.emoji,
        });
      } else {
        dispatch({ t: 'add', item: renderEvent(e) });
      }
    });
    const statusSub = deps.bus.status$.subscribe(setStatus);
    return () => {
      eventsSub.unsubscribe();
      statusSub.unsubscribe();
    };
  }, []);

  const [inputKey, clearInput] = useReducer((x: number) => x + 1, 0);
  const localSeq = useRef(0);
  const localId = () => `local-${localSeq.current++}`;

  // Quit: stash the FULL transcript (debug included) so main.ts can print it to the restored screen —
  // the alternate buffer has no native scrollback, so this is how the conversation survives.
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
    // terminals translate the MOUSE WHEEL into ↑/↓ — so this is wheel scroll too.
    if (key.upArrow) return scrollByLines(-1);
    if (key.downArrow) return scrollByLines(1);
  });

  const { ctx, running, speaker, thinking } = status;
  const who = speaker.charAt(0).toUpperCase() + speaker.slice(1);

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) return;
    const cmdCtx: CommandContext = {
      note: (t) =>
        dispatch({ t: 'add', item: { id: localId(), kind: 'note', text: t } }),
      exit: exitApp,
      setDebug: (show) => {
        const next = show ?? !showDebug;
        setShowDebug(next);
        return next;
      },
      setActiveChannel: (channelId) => {
        deps.surface.setActiveChannel(channelId);
        setActiveChannel(channelId);
        setFollow(true);
      },
    };
    if (runCommand(deps.commands, text, cmdCtx)) {
      clearInput();
      return;
    }
    deps.surface.send(text); // → SurfaceBridge → conductor → channel
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
      {/* The scroll viewport: clips to its height; the content column is shifted up by `offset`
          LINES. The input sits OUTSIDE it, so it's always visible however far you scroll. */}
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
      <Box flexShrink={0}>
        <Text color="cyan">{`${who} @ ${activeChannel.replace(/^tui:/, '')} ❯ `}</Text>
        <TextInput
          key={inputKey}
          placeholder="message   ·   /room <name>   ·   /dm <bot>   ·   /rooms   ·   /as   ·   /debug   ·   /exit"
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
