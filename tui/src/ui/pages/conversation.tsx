import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { basename } from "node:path";
import type { OpenConversation } from "../../app/conversation.service.js";
import { withSeams, type TranscriptItem } from "../../domain/seam.js";
import {
  expandableIds,
  toolResultsById,
} from "../../domain/transcript-index.js";
import { conversationHints } from "../../domain/conversation-hints.js";
import { roleLabel } from "../../domain/role-engine.js";
import { EThreadStatus } from "../../generated/prisma/enums.js";
import { CONVERSATION, EDITING, GLOBAL } from "../bindings.js";
import { runSlashCommand } from "../commands.js";
import { glyph, theme } from "../theme.js";
import { Breadcrumb } from "../components/breadcrumb.js";
import { useJobSiblings } from "../hooks/use-job-siblings.js";
import { useTasks } from "../hooks/use-tasks.js";
import { Checklist } from "../components/checklist.js";
import { Composer, composerRows } from "../components/composer.js";
import { HintLine } from "../components/hint-line.js";
import { JumpToBottom } from "../components/new-divider.js";
import { OverlayList, type OverlayItem } from "../components/overlay-list.js";
import { Screen } from "../components/screen.js";
import { Shortcuts, shortcutRows } from "../components/shortcuts.js";
import { Transcript } from "../components/transcript.js";
import { ProposalFooter } from "../components/transition-confirm.js";
import { useComposer } from "../hooks/use-composer.js";
import { useProposal } from "../hooks/use-proposal.js";
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
    hint: "ask this agent to hand over to a fresh session",
  },
  { id: "/context", label: "/context", hint: "the job’s shared folder" },
  { id: "/doctor", label: "/doctor", hint: "is my setup current and working" },
  // `/compact` is gone rather than renamed: the SDK rejects it outright and auto-compaction is
  // disabled, so rotation is the only way context is reclaimed. Typing it still works — it is
  // aliased onto `/rotate` in `parseSlashCommand` — because the fingers that know it want that.
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

  // What a tool call resolved to, so it can draw its result inline beneath itself.
  const toolResults = useMemo(
    () => toolResultsById(state.messages),
    [state.messages],
  );

  // Everything `x` / `X` can open, in the order it was said — tool blocks AND the file chips on a
  // seam message, which share one expansion set because to a reader they are one gesture.
  const toolCallIds = useMemo(
    () => expandableIds(state.messages),
    [state.messages],
  );

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

  // The job's pending phase advance, job-scoped rather than thread-scoped: the proposer may not be
  // the thread on screen, and confirming has to stay one keypress from the JOB.
  const proposal = useProposal({
    jobId: props.open.job.id,
    cwd: props.open.cwd,
    revision: state.messages.length,
    draftLength: composer.value.length,
  });

  const submit = useCallback(async () => {
    const text = composer.value.trim();
    if (text.length === 0) return;
    composer.clear();
    setOverlay("none");
    // A command RUNS rather than going to the model as text — see `runSlashCommand`.
    if (await runSlashCommand({ text, conversation: conversationService })) return;
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
    // While a proposal is up it owns `y`, `n`, `x` and `esc` — see `suspended`.
    suspended: proposal.open,
  });

  const hints = conversationHints({
    shortcutsOpen: shortcuts,
    threadClosed: closed,
    clearArmed,
    running: state.running,
    queuedCount: state.queued.length,
    draftLength: composer.value.length,
  });

  // The agent's plan, if it wrote one down — re-read as the transcript grows (see `useTasks`).
  const threadId = props.open.thread.id;
  const tasks = useTasks({ threadId, revision: state.messages.length });

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

          {/* Pinned above the composer rather than left in the transcript, where a scroll would
              carry the one thing you check while it works off the screen. Draws nothing when there
              are no tasks, so a thread that never wrote a plan pays no rows for it. */}
          <Checklist tasks={tasks} width={width} />

          {/* Landing mid-history needs a way out that you can SEE — the keyboard belongs to the
              draft here, so a key on its own would be a secret. It goes directly above the composer
              rather than floating in the transcript, where a scroll would carry it off screen. */}
          {readState.pinned ? null : (
            <JumpToBottom onJump={readState.handleJumpToBottom} />
          )}

          {/* Above the command palette because it is the only overlay that arrived unbidden — and
              only ever one of the two is up, since it owns the keyboard while it is. */}
          <ProposalFooter proposal={proposal} width={width} height={height} />

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
