import { useTerminalDimensions } from "@opentui/react";
import { useInput } from "../hooks/use-input.js";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { basename } from "node:path";
import type { OpenConversation } from "../../app/conversation.service.js";
import type { ToolResultPayload } from "../../domain/message.js";
import { withSeams, type TranscriptItem } from "../../domain/seam.js";
import { roleLabel } from "../../domain/role-engine.js";
import { EMessageType } from "../../generated/prisma/enums.js";
import { CONVERSATION, EDITING, GLOBAL } from "../bindings.js";
import { formatElapsed, glyph, theme, TRANSCRIPT_PADDING } from "../theme.js";
import { AssistantBlock } from "../components/blocks/assistant-block.js";
import { SessionSeam, SwapNotice } from "../components/blocks/error-block.js";
import { ThinkingBlock } from "../components/blocks/thinking-block.js";
import { ToolRunningLine } from "../components/blocks/tool-block.js";
import { Breadcrumb } from "../components/breadcrumb.js";
import { Composer, composerRows } from "../components/composer.js";
import { HintLine } from "../components/hint-line.js";
import { MessageView } from "../components/message-view.js";
import { OverlayList, type OverlayItem } from "../components/overlay-list.js";
import { Screen } from "../components/screen.js";
import { Shortcuts, shortcutRows } from "../components/shortcuts.js";
import { WorkingLine } from "../components/working-line.js";
import { useComposer } from "../hooks/use-composer.js";
import { useConversation, useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";

const TranscriptRow = React.memo(function TranscriptRow(props: {
  item: TranscriptItem;
  width: number;
}): React.ReactNode {
  return props.item.kind === "seam" ? (
    <SessionSeam
      ordinal={props.item.ordinal}
      width={Math.min(props.width, 72)}
    />
  ) : (
    <MessageView message={props.item.message} />
  );
});

const COMMANDS: OverlayItem[] = [
  {
    id: "/thread",
    label: "/thread",
    hint: "open a sibling thread with a given role",
  },
  {
    id: "/rotate",
    label: "/rotate",
    hint: "close this session and start the next",
  },
  { id: "/context", label: "/context", hint: "the job’s shared folder" },
  { id: "/doctor", label: "/doctor", hint: "is my setup current and working" },
  { id: "/compact", label: "/compact", hint: "summarise and free context" },
  { id: "/help", label: "/help", hint: "shortcuts" },
  { id: "/quit", label: "/quit", hint: "exit atlas" },
];

export function ConversationPage(props: {
  open: OpenConversation;
  onBack: () => void;
}): React.ReactNode {
  const { conversationService, conversationStores } = useServices();
  const state = useConversation(props.open.thread.id);
  const { width, height } = useTerminalDimensions();
  const [shortcuts, setShortcuts] = useState(false);

  // Seeded from the store, which kept the draft while this page was unmounted. See `store.draft`.
  const store = conversationStores.for(props.open.thread.id);
  const composer = useComposer(store.draft);
  const [overlay, setOverlay] = useState<"none" | "command">("none");
  // Esc is one keystroke away from a paragraph you meant to send, so clearing asks twice. Armed is a
  // moment, not a mode: any other key disarms it, and it lapses on its own.
  const [clearArmed, setClearArmed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const { now, frame } = useTick(state.running);

  const toggleTool = useCallback((toolUseId: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(toolUseId)) {
        next.delete(toolUseId);
      } else {
        next.add(toolUseId);
      }
      return next;
    });
  }, []);

  // Seams are DERIVED from adjacent messages changing session — nothing stitches anything.
  const items = useMemo<TranscriptItem[]>(
    () => withSeams(state.messages, props.open.sessions),
    [state.messages, props.open.sessions],
  );

  // Build a map of toolUseId → result payload so tool calls can render their results inline.
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultPayload>();
    for (const msg of state.messages) {
      if (msg.payload.type === EMessageType.tool_result) {
        map.set(msg.payload.toolUseId, msg.payload);
      }
    }
    return map;
  }, [state.messages]);

  // Collect tool call IDs in order for keyboard navigation.
  const toolCallIds = useMemo(() => {
    const ids: string[] = [];
    for (const msg of state.messages) {
      if (msg.payload.type === EMessageType.tool_call) {
        ids.push(msg.payload.toolUseId);
      }
    }
    return ids;
  }, [state.messages]);

  // One stable key per item.
  const itemKeys = useMemo(
    () =>
      items.map((item, index) =>
        item.kind === "seam" ? `seam-${index}` : item.message.id,
      ),
    [items],
  );

  const filteredCommands = useMemo(
    () =>
      overlay === "command"
        ? COMMANDS.filter((c) =>
            c.label.startsWith(composer.value.split(" ")[0] ?? ""),
          )
        : [],
    [overlay, composer.value],
  );

  useEffect(() => setSelected(0), [composer.value]);

  // Written on every change rather than on unmount: leaving is not the only way out of this page, and
  // a cleanup would miss the ones that are not (a crash, a quit, a job deleted underneath us).
  useEffect(() => {
    store.draft = composer.value;
  }, [store, composer.value]);

  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [clearArmed]);

  const submit = useCallback(async () => {
    const text = composer.value.trim();
    if (text.length === 0) return;
    composer.clear();
    setOverlay("none");
    // Sending is an implicit "show me what happens next".
    await conversationService.send(text);
  }, [composer, conversationService]);

  useInput((input, key) => {
    // --- overlay navigation (opens upward; the composer never moves) -------------------------
    if (overlay === "command") {
      if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
      if (key.downArrow)
        return setSelected((s) => Math.min(filteredCommands.length - 1, s + 1));
      if (key.escape) {
        setOverlay("none");
        composer.clear();
        return;
      }
      if (key.return) {
        const chosen = filteredCommands[selected];
        composer.setValue(chosen ? `${chosen.label} ` : composer.value);
        setOverlay("none");
        return;
      }
    }

    // --- leave, without touching the turn --------------------------------------------------------
    // `←` on an empty composer is BACK, and it is deliberately a different key from `esc`. Esc means
    // "stop what you are doing" here; overloading it with "and also leave" makes the two impossible
    // to separate, and the one you reach for when you want to walk away from a working agent is the
    // one that kills it. Leaving never interrupts — the turn keeps running.
    if (key.leftArrow && composer.value.length === 0) {
      props.onBack();
      return;
    }

    // --- interrupt, or discard the draft ----------------------------------------------------------
    if (key.escape) {
      // Esc with an empty composer interrupts bare. Esc with text is a STEER-NOW: interrupt, then
      // deliver immediately rather than waiting for a boundary that will never come. Neither one
      // loses the draft, so neither one asks first.
      if (state.running) {
        const pending = composer.value.trim();
        composer.clear();
        void conversationService.interrupt(
          pending.length > 0 ? pending : undefined,
        );
        return;
      }

      // Idle and empty: esc has no work to do.
      if (composer.value.length === 0) return;

      if (clearArmed) {
        setClearArmed(false);
        composer.clear();
        return;
      }

      // The draft now survives leaving the page, so a single key is the only way left to lose it by
      // accident. It takes two.
      setClearArmed(true);
      return;
    }

    // Every other key means the user moved on; a warning left standing would make a later, innocent
    // esc an unwarned discard, which is the exact thing it exists to prevent.
    if (clearArmed) setClearArmed(false);

    if (key.ctrl && input === "u") {
      // Idle: clear the composer. Busy: clear the steer queue — the two things ctrl+u can mean.
      if (state.running)
        return conversationStores.for(props.open.thread.id).clearQueue();
      return composer.clear();
    }
    if (key.ctrl && input === "h") return props.onBack();

    // `?` on an empty composer TOGGLES the keymap in the footer, where the hint line has always
    // advertised it. Non-empty, it is just a question mark — typing during a turn stays safe.
    if (
      input === "?" &&
      composer.value.length === 0 &&
      !key.ctrl &&
      !key.meta
    ) {
      return setShortcuts((open) => !open);
    }

    // Plain Return sends. Return with ANY modifier falls through to the composer as a newline.
    if (key.return && !key.shift && !key.meta && !key.ctrl) {
      void submit();
      return;
    }

    // --- the composer gets first refusal ------------------------------------------------------
    // It returns false for anything it cannot use — a caret already at the top, or any navigation
    // at all while empty. What it declines falls to the bindings below, NOT to the transcript:
    // scrolling is the wheel's job now that real wheel reports arrive.
    if (composer.handleKey(input, key)) {
      // `/` on an empty composer opens the palette. Typing during a busy turn is ALWAYS safe.
      if (input === "/" && composer.value.length === 1) setOverlay("command");
      return;
    }

    // `x` toggles the most recent tool block, `X` toggles all
    if (input === "x" && !key.ctrl && !key.meta) {
      const lastToolId = toolCallIds[toolCallIds.length - 1];
      if (lastToolId) toggleTool(lastToolId);
      return;
    }
    if (input === "X" && !key.ctrl && !key.meta) {
      // Toggle all: if any are collapsed, expand all; otherwise collapse all
      const allExpanded = toolCallIds.every((id) => expandedTools.has(id));
      setExpandedTools(allExpanded ? new Set() : new Set(toolCallIds));
      return;
    }

    // ↑↓ deliberately do NOT scroll — they belong to the composer's caret, and past it they are
    // reserved for navigation. Scrolling is the wheel's alone: PgUp/PgDn were claimed here for a
    // while and never worked, because a key only reached the transcript while it held focus — and a
    // transcript holding focus ALSO answered ↑/↓, which is the bug this comment used to describe as a
    // feature. Home/End belong to the draft's line, not the transcript's.
  });

  const hints = shortcuts
    ? "? close"
    : clearArmed
      ? "esc again to clear the draft"
      : state.running
        ? state.queued.length > 0
          ? "ctrl+u clear queue · esc interrupt · ← leave"
          : "esc interrupt · ← leave it running"
        : composer.value.length > 0
          ? "esc clear · ⏎ send"
          : "← back · ? for shortcuts";

  return (
    <Screen
      header={
        <Breadcrumb
          project={basename(props.open.cwd)}
          job={props.open.job.title}
          role={roleLabel(props.open.thread.role)}
          sessionOrdinal={props.open.session.ordinal}
          engine={props.open.session.engine}
          model={props.open.session.model}
          width={width}
          readOnly={props.open.readOnly}
        />
      }
      footer={
        <box flexDirection="column">
          {props.open.readOnly ? (
            <text fg={theme.warn}>
              {glyph.warning} another atlas has this thread — opened read-only
            </text>
          ) : null}

          {/* Overlays render ABOVE the composer. */}
          {overlay === "command" ? (
            <OverlayList
              items={filteredCommands}
              selected={selected}
              emptyMessage="no such command"
            />
          ) : null}

          <Composer
            state={composer.state}
            width={width}
            maxRows={composerRows(height)}
            onCaret={composer.setCursor}
          />

          {/* Below the composer, in the hint line's place: the keymap belongs where "what can I
              press" already lives, and the meter line stays put underneath it so the panel never
              costs you the one thing the footer shows all the time. */}
          {shortcuts ? (
            <Shortcuts
              bindings={[...CONVERSATION, ...EDITING, ...GLOBAL]}
              width={width}
              maxRows={shortcutRows(height)}
            />
          ) : null}

          <HintLine
            hints={hints}
            contextPercent={state.contextPercent}
            fiveHour={state.fiveHour}
            sevenDay={state.sevenDay}
            width={width}
          />
        </box>
      }
    >
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        flexBasis={0}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        viewportCulling
        // The padding goes on the CONTENT box, not the scrollbox: padding on the scrollbox itself
        // insets the scrollbar along with the text, which just moves the collision. See
        // `TRANSCRIPT_PADDING`.
        contentOptions={{ paddingRight: TRANSCRIPT_PADDING }}
      >
        {items.map((item, index) => {
          const key = itemKeys[index] ?? String(index);
          return (
            <box key={key} flexDirection="column">
              {item.kind === "seam" ? (
                <SessionSeam
                  ordinal={item.ordinal}
                  width={Math.min(width, 72)}
                />
              ) : (
                <MessageView
                  message={item.message}
                  toolResults={toolResults}
                  expandedTools={expandedTools}
                  onToggleTool={toggleTool}
                />
              )}
            </box>
          );
        })}

        {state.messages.length === 0 && !state.running ? (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.dim}>{props.open.cwd}</text>
            <text> </text>
            <text fg={theme.dim}>Describe the work, or / for commands.</text>
          </box>
        ) : null}

        {state.notices.map((notice, index) => (
          <SwapNotice key={index} text={notice} />
        ))}

        {state.tail?.kind === "text" ? (
          <AssistantBlock text={state.tail.text} streaming />
        ) : null}
        {state.tail?.kind === "thinking" ? (
          <ThinkingBlock text={state.tail.text} streaming />
        ) : null}

        {state.runningTool ? (
          <ToolRunningLine
            frame={frame}
            elapsed={formatElapsed(now - state.runningTool.startedAt)}
            lines={state.runningTool.lines}
          />
        ) : null}

        {state.running && state.startedAt !== null ? (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              running
              elapsedMs={now - state.startedAt}
              frame={frame}
              outputTokens={state.outputTokens}
              queued={state.queued}
              interrupting={state.interrupting}
            />
          </box>
        ) : state.lastTurn ? (
          <box flexDirection="row" marginTop={1} marginBottom={1}>
            <WorkingLine
              running={false}
              elapsedMs={state.lastTurn.durationMs}
              frame={frame}
              outputTokens={state.lastTurn.outputTokens}
              queued={state.queued}
              interrupting={false}
            />
          </box>
        ) : null}
      </scrollbox>
    </Screen>
  );
}
