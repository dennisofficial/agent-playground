import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { basename } from "node:path";
import type { OpenConversation } from "../../app/conversation.service.js";
import type { ToolResultPayload } from "../../domain/message.js";
import { withSeams, type TranscriptItem } from "../../domain/seam.js";
import { conversationHints } from "../../domain/conversation-hints.js";
import { roleLabel } from "../../domain/role-engine.js";
import { EMessageType, EThreadStatus } from "../../generated/prisma/enums.js";
import { CONVERSATION, EDITING, GLOBAL } from "../bindings.js";
import { glyph, theme } from "../theme.js";
import { Breadcrumb } from "../components/breadcrumb.js";
import { useJobSiblings } from "../hooks/use-job-siblings.js";
import { Composer, composerRows } from "../components/composer.js";
import { HintLine } from "../components/hint-line.js";
import { JumpToBottom } from "../components/new-divider.js";
import { OverlayList, type OverlayItem } from "../components/overlay-list.js";
import { Screen } from "../components/screen.js";
import { Shortcuts, shortcutRows } from "../components/shortcuts.js";
import { Transcript } from "../components/transcript.js";
import { useComposer } from "../hooks/use-composer.js";
import { useConversationKeys } from "../hooks/use-conversation-keys.js";
import { useConversation, useTick } from "../hooks/use-conversation.js";
import { useReadState } from "../hooks/use-read-state.js";
import { useServices } from "../services.js";

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
  /** `ctrl+h` — the job's phases and threads, and how you reach a closed one. */
  onThreads: () => void;
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
  const closed = props.open.thread.status === EThreadStatus.closed;

  // Where you land, where the rule goes, and when `lastSeenAt` is written. `lastSeenAt` is read off
  // the thread as it stood when the conversation opened, on purpose: a live read would move the
  // boundary out from under you the moment the write-through fired.
  const readState = useReadState({
    threadId: props.open.thread.id,
    lastSeenAt: props.open.thread.lastSeenAt,
    messages: state.messages,
  });

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

  useConversationKeys({
    composer,
    conversationService,
    conversationStores,
    threadId: props.open.thread.id,
    running: state.running,
    overlay,
    setOverlay,
    filteredCommands,
    selected,
    setSelected,
    clearArmed,
    setClearArmed,
    setShortcuts,
    submit,
    toolCallIds,
    expandedTools,
    setExpandedTools,
    toggleTool,
    onBack: props.onBack,
    onThreads: props.onThreads,
    onJumpToBottom: readState.handleJumpToBottom,
  });

  const hints = conversationHints({
    shortcutsOpen: shortcuts,
    threadClosed: closed,
    clearArmed,
    running: state.running,
    queuedCount: state.queued.length,
    draftLength: composer.value.length,
  });

  // Other threads of this job working behind this one. Not other tiles — those are other tickets.
  const siblings = useJobSiblings({
    jobId: props.open.job.id,
    currentThreadId: props.open.thread.id,
  });

  return (
    <Screen
      header={
        <Breadcrumb
          width={width}
          facts={{
            jobTitle: props.open.job.title,
            // The repository, not the working directory: a job in a worktree would otherwise be
            // headed by its own slug, which says nothing you do not already know from the branch.
            repo: basename(props.open.job.workspacePath ?? props.open.cwd),
            role: roleLabel(props.open.thread.role),
            sessionOrdinal: props.open.session.ordinal,
            engine: props.open.session.engine,
            model: props.open.session.model,
            branch: props.open.job.branch,
            siblings,
            closed: props.open.closed,
          }}
        />
      }
      footer={
        <box flexDirection="column">
          {/* One cause now, and a permanent one. The other used to be another terminal's lock,
              which lifted on its own and made this line a lie the moment it did. */}
          {props.open.closed ? (
            <text fg={theme.warn}>
              {glyph.warning} this thread is closed — reading its record
            </text>
          ) : null}

          {/* Landing mid-history needs a way out that you can SEE — the keyboard belongs to the
              draft here, so a key on its own would be a secret. It goes directly above the composer
              rather than floating in the transcript, where a scroll would carry it off screen. */}
          {readState.pinned ? null : (
            <JumpToBottom onJump={readState.handleJumpToBottom} />
          )}

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
      <Transcript
        items={items}
        itemKeys={itemKeys}
        state={state}
        toolResults={toolResults}
        expandedTools={expandedTools}
        onToggleTool={toggleTool}
        now={now}
        frame={frame}
        cwd={props.open.cwd}
        width={width}
        scroller={readState.scroller}
        anchorMessageId={readState.anchorMessageId}
        showDivider={readState.showDivider}
      />
    </Screen>
  );
}
