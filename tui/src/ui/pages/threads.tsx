import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { clampIndex } from "../../domain/list-nav.js";
import { threadList, threadsLayout } from "../../domain/threads-list.js";
import {
  EWorkspaceKind,
  workspaceState,
  type WorkspaceState,
} from "../../domain/worktree.js";
import { EThreadStatus } from "../../generated/prisma/enums.js";
import type { Job, Thread } from "../../generated/prisma/client.js";
import type { ThreadRow } from "../../store/thread.repository.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import { ListEmpty } from "../components/list-parts.js";
import { ListFooter } from "../components/list-footer.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { PhaseGroup } from "../components/thread-list.js";
import { VerbMenu } from "../components/verb-menu.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { EHumanVerb, useHumanVerbs } from "../hooks/use-human-verbs.js";
import { useInput } from "../hooks/use-input.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";

/**
 * Page 6 — the job's phases and the threads inside them.
 *
 * Threads are HISTORY, not concurrent workers: a rotation retires a session, and a completed thread
 * stays as the record of a leg. So this reads as a timeline you browse, with the one or two live
 * rows at the frontier — which is why closed rows are reachable and dim rather than hidden.
 */
export function ThreadsPage(props: {
  job: Job;
  projectName: string;
  /** The thread the conversation above is on — where the cursor starts. */
  currentThreadId: string;
  /**
   * `Thread` rather than `ThreadRow`: a thread Dennis has just opened by hand is a fresh row with no
   * list statistics on it yet, and it must take him there without a round trip through this list.
   */
  onOpen: (thread: Thread) => void;
  /** Where a thread opened from here runs — the route's cwd, worktree or not. */
  cwd: string;
  onEnterWorktree: () => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService, threadSeamService } = useServices();
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [proposalThreadIds, setProposalThreadIds] = useState<string[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    props.job.activeThreadId,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const { width, height } = useTerminalDimensions();

  // Which threads have an agent working in them right now — the whole reason to leave one running
  // and come back. A turn starting or finishing also changes a row's message count, so the list
  // re-reads on the same signal: one SQLite read, only when the working set actually moves.
  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    const [rows, job, facts, pending] = await Promise.all([
      workspaceService.listThreads(props.job.id),
      workspaceService.findJob(props.job.id),
      workspaceService.jobWorkspace(props.job.id),
      // Which of these threads is waiting on a keypress. Read on the same beat as the rows, because
      // a proposal is raised inside a turn and the turn ending is already what re-reads this page.
      threadSeamService.pendingTransitions(props.job.id),
    ]);
    setThreads(rows);
    setWorkspace(facts ? workspaceState(facts) : null);
    setProposalThreadIds(
      pending.flatMap((row) =>
        row.raisedByThreadId === null ? [] : [row.raisedByThreadId],
      ),
    );
    // The cursor is orchestration state, not this page's: an agent opening a thread moves it while
    // the list is up, so ACTIVE is re-read rather than taken from the route's snapshot of the job.
    if (job) setActiveThreadId(job.activeThreadId);
  }, [workspaceService, threadSeamService, props.job.id]);

  useEffect(() => {
    void reload();
  }, [reload, running.length]);

  const { groups, order } = useMemo(
    () =>
      threadList({
        threads: threads ?? [],
        activeThreadId,
        runningThreadIds: running,
        proposalThreadIds,
      }),
    [threads, activeThreadId, running, proposalThreadIds],
  );

  // Null until the list arrives, so the landing row is chosen ONCE — from the thread you came from,
  // not from row zero. After that it is the user's cursor and nothing moves it.
  const cursor =
    selected === null
      ? Math.max(
          0,
          order.findIndex((row) => row.id === props.currentThreadId),
        )
      : clampIndex(selected, order.length);
  const highlighted = order[cursor];

  const layout = threadsLayout(width);

  // What `c` would close: whatever the cursor is standing on, plus the two facts that only change
  // the wording of the question.
  const target = useMemo(() => {
    if (!highlighted) return undefined;
    const row = (threads ?? []).find(
      (candidate) => candidate.id === highlighted.id,
    );
    if (!row) return undefined;
    const openInPhase = (threads ?? []).filter(
      (candidate) =>
        candidate.phaseId === row.phaseId &&
        candidate.status !== EThreadStatus.closed,
    );
    return {
      id: row.id,
      role: row.role,
      closed: row.status === EThreadStatus.closed,
      running: running.includes(row.id),
      last: openInPhase.length <= 1,
    };
  }, [highlighted, threads, running]);

  // The three moves Dennis makes himself. They own `p`, `n` and `c`, and while a menu is up they own
  // the whole keyboard — see `handleKey`.
  const verbs = useHumanVerbs({
    jobId: props.job.id,
    cwd: props.cwd,
    target,
    revision: (threads ?? []).length,
    onChanged: () => void reload(),
    onOpened: props.onOpen,
  });

  useInput((input, key) => {
    // First refusal, and the page stands down on anything it claims: every `useKeyboard` listener
    // fires for every key and there is no propagation to stop, so a menu and a list cannot both
    // answer `↑`.
    if (verbs.handleKey(input, key)) return;
    // `←` and `esc` are the same door on a list — see the jobs page.
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) return setSelected(clampIndex(cursor - 1, order.length));
    if (key.downArrow) return setSelected(clampIndex(cursor + 1, order.length));
    if (key.return || key.rightArrow) {
      const row = highlighted;
      if (!row) return;
      const thread = (threads ?? []).find((candidate) => candidate.id === row.id);
      if (thread) props.onOpen(thread);
      return;
    }
    // Late and reversible, never a fork at creation: a job runs in place until it earns isolation,
    // and `enter()` is idempotent, so this is safe to press at any point including twice.
    if (input === "w" && workspace?.kind === EWorkspaceKind.inPlace) {
      return props.onEnterWorktree();
    }
    // Still no `?` panel: the keys fit the hint line, which measures rather than thresholds. `n` now
    // means what the shared list keymap always said it did — a thread IS opened by hand here, since
    // a job with nothing running has no agent left to open one.
  });

  const trail = ["atlas", props.projectName, props.job.title];

  if (threads === null) {
    return (
      <Screen header={<PageHeader trail={trail} canBack right="threads" />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={<PageHeader trail={trail} canBack right="threads" />}
      footer={
        <ListFooter
          width={width}
          height={height}
          menu={
            verbs.verb === EHumanVerb.phase || verbs.verb === EHumanVerb.role ? (
              <VerbMenu
                title={verbs.title}
                items={verbs.items}
                selected={verbs.selected}
                caption={verbs.caption}
                error={verbs.error}
              />
            ) : null
          }
          confirm={
            verbs.confirm ? (
              <ConfirmBar
                question={verbs.confirm.question}
                detail={verbs.confirm.detail}
                confirmLabel="close"
              />
            ) : null
          }
          // A menu owns the footer while it is up, exactly as a mode does on the jobs page: the
          // hints under it would be advertising keys the menu has taken.
          hints={
            verbs.verb !== EHumanVerb.browse
              ? undefined
              : workspace?.kind === EWorkspaceKind.inPlace
                ? IN_PLACE_HINTS
                : HINTS
          }
          shortcuts={false}
          // A menu draws its own failure inside itself, beneath the list it belongs to. Everywhere
          // else — including a close that threw, where the bar stays up — it lands in the footer's
          // one error line rather than a second one nobody knows to look at.
          error={
            verbs.verb === EHumanVerb.phase || verbs.verb === EHumanVerb.role
              ? null
              : verbs.error
          }
        />
      }
    >
      {/* Where this job's agents stand, above the threads rather than beside one, because it is
          true of the JOB — every thread in it runs in the same tree. */}
      {workspace ? (
        <box flexDirection="column">
          <text>
            <span
              fg={
                workspace.kind === EWorkspaceKind.missing ? theme.warn : theme.dim
              }
            >
              {workspace.glyph} {workspace.label}
            </span>
          </text>
          <text> </text>
        </box>
      ) : null}

      {/* A job is created with one generic thread, so an empty list means something went wrong
          underneath rather than "nothing here yet" — say so instead of drawing a blank page. */}
      <ListEmpty
        show={groups.length === 0}
        headline="This job has no threads."
        hint="A job opens with one, so this is a job that lost its phase."
      />

      {groups.map((group) => (
        <PhaseGroup
          key={group.phaseId}
          group={group}
          cursor={cursor}
          layout={layout}
          frame={frame}
        />
      ))}
    </Screen>
  );
}

/**
 * Longest-first, and the widest that fits wins — these measure, they do not threshold.
 *
 * The three human verbs are advertised here rather than in a keymap panel because this page has
 * never had one: the hint line holds them, and a job with nothing running has to SHOW that `p` and
 * `n` exist or the state is a dead end that looks like a bug.
 */
const HINTS = [
  "↑↓ select · →/⏎ open · p start a phase · n new thread · c close · ←/esc back",
  "↑↓ select · ⏎ open · p phase · n thread · c close · esc back",
  "⏎ open · p phase · n thread · esc back",
];

/** `w` is offered only where it does something — a job already in a worktree cannot take another. */
const IN_PLACE_HINTS = [
  "↑↓ select · →/⏎ open · p start a phase · n new thread · c close · w worktree · ←/esc back",
  "↑↓ select · ⏎ open · p phase · n thread · c close · w worktree · esc back",
  "⏎ open · p phase · n thread · w worktree · esc",
];
