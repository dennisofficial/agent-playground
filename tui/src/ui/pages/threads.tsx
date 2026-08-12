import { useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { clampIndex } from "../../domain/list-nav.js";
import { threadList, threadsLayout } from "../../domain/threads-list.js";
import type { Job } from "../../generated/prisma/client.js";
import type { ThreadRow } from "../../store/thread.repository.js";
import { ListEmpty } from "../components/list-parts.js";
import { ListFooter } from "../components/list-footer.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { PhaseGroup } from "../components/thread-list.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
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
  /** The thread the conversation underneath is on — where the cursor starts. */
  currentThreadId: string;
  onOpen: (thread: ThreadRow) => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService } = useServices();
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    props.job.activeThreadId,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const { width, height } = useTerminalDimensions();

  // Which threads have an agent working in them right now — the whole reason to leave one running
  // and come back. A turn starting or finishing also changes a row's message count, so the list
  // re-reads on the same signal: one SQLite read, only when the working set actually moves.
  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    const [rows, job] = await Promise.all([
      workspaceService.listThreads(props.job.id),
      workspaceService.findJob(props.job.id),
    ]);
    setThreads(rows);
    // The cursor is orchestration state, not this page's: an agent opening a thread moves it while
    // the list is up, so ACTIVE is re-read rather than taken from the route's snapshot of the job.
    if (job) setActiveThreadId(job.activeThreadId);
  }, [workspaceService, props.job.id]);

  useEffect(() => {
    void reload();
  }, [reload, running.length]);

  const { groups, order } = useMemo(
    () =>
      threadList({
        threads: threads ?? [],
        activeThreadId,
        runningThreadIds: running,
      }),
    [threads, activeThreadId, running],
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

  useInput((input, key) => {
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
    // No `?` panel here on purpose: the shared list keymap advertises `n new` and `x delete`, and a
    // thread is opened by an agent or a phase, never by `n` on this page. Four keys fit in the hint
    // line, so a panel that would have to lie about two of them earns nothing.
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
          hints={HINTS}
          shortcuts={false}
          error={null}
        />
      }
    >
      {/* A job is created with one intake thread, so an empty list means something went wrong
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

const HINTS = [
  "↑↓ select · →/⏎ open · ←/esc back",
  "↑↓ select · ⏎ open · esc back",
  "⏎ open · esc back",
];
