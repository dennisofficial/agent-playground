import { useTerminalDimensions } from "@opentui/react";
import { useInput } from "../hooks/use-input.js";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ProjectRow } from "../../app/workspace.service.js";
import type { JobRow } from "../../store/job.repository.js";
import { clampIndex, matchesQuery } from "../../domain/list-nav.js";
import { deletionCost, jobSummary, jobsLayout } from "../../domain/jobs-list.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import { ListFooter } from "../components/list-footer.js";
import { JobListRow } from "../components/job-list.js";
import { AddRow, ListEmpty, NoMatch } from "../components/list-parts.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer } from "../hooks/use-composer.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";
import {
  ARCHIVED_HINTS,
  HINTS,
  headerRight,
  overlayFor,
  type Mode,
  type View,
} from "./jobs-chrome.js";

export function JobsPage(props: {
  project: ProjectRow;
  /** The job last opened — the cursor lands on it when you come back, not on row zero. */
  focusId?: string | undefined;
  onOpen: (job: JobRow) => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService, attentionService } = useServices();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [view, setView] = useState<View>("open");
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [shortcuts, setShortcuts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { width, height } = useTerminalDimensions();
  // A filter and a job title, never a draft: one line.
  const composer = useComposer("", { singleLine: true });

  // Which of these jobs has an agent working in it right now. Without this a job you walked away
  // from is indistinguishable from an idle one, and the whole point of leaving it running is lost.
  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);

  const reload = useCallback(async () => {
    setJobs(
      view === "archived"
        ? await attentionService.listArchivedJobs(props.project.id)
        : await workspaceService.listJobs(props.project.id),
    );
  }, [attentionService, workspaceService, props.project.id, view]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A turn starting or finishing changes `updatedAt` and the message count under us. Cheap: one
  // SQLite read, and only when the set of working threads actually changes.
  useEffect(() => {
    void reload();
  }, [running.length, reload]);

  // The composer IS the query while filtering — see the same note on the projects page.
  const query = mode === "filter" ? composer.value : "";

  const all = useMemo(() => jobs ?? [], [jobs]);
  const rows = useMemo(
    // The phase and the role left the row when the status column became the verb you owe, but they
    // are still the most natural thing to type when hunting for a job by what it was doing.
    () => all.filter((job) => matchesQuery(query, job.title, jobSummary(job))),
    [all, query],
  );
  // The shelf has no `+ new job`: a job you create is a job you are working on, by definition.
  const canCreate = view === "open";
  const total = rows.length + (canCreate ? 1 : 0);
  const layout = jobsLayout(width);

  const cursor = clampIndex(selected, total);
  const highlighted = cursor < rows.length ? rows[cursor] : undefined;

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || jobs === null) return;
    restored.current = true;
    const index = props.focusId
      ? jobs.findIndex((job) => job.id === props.focusId)
      : -1;
    if (index >= 0) setSelected(index);
  }, [jobs, props.focusId]);

  const leaveMode = useCallback(() => {
    setMode("browse");
    composer.clear();
  }, [composer]);

  const create = useCallback(
    (title: string) => {
      if (title.length === 0) return;
      leaveMode();
      void workspaceService
        .createJob({ projectId: props.project.id, title })
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, props.project.id, reload, workspaceService],
  );

  const remove = useCallback(
    (job: JobRow) => {
      leaveMode();
      setError(null);
      void workspaceService
        .deleteJob(job.id)
        .then(() => reload())
        .catch((e: Error) => setError(e.message));
    },
    [leaveMode, reload, workspaceService],
  );

  // No confirm on either of these: archiving destroys nothing and restoring un-destroys nothing,
  // and one keypress back is the whole point of having a shelf instead of a second delete.
  const shelve = useCallback(
    (job: JobRow) => {
      setError(null);
      const move =
        view === "archived"
          ? attentionService.restoreJob(job.id)
          : attentionService.archiveJob(job.id);
      void move.then(() => reload()).catch((e: Error) => setError(e.message));
    },
    [attentionService, reload, view],
  );

  useInput((input, key) => {
    if (mode === "create") {
      if (key.escape) return leaveMode();
      if (key.return) return create(composer.value.trim());
      composer.handleKey(input, key);
      return;
    }

    if (mode === "confirm") {
      if (input === "y" && highlighted) return remove(highlighted);
      return leaveMode();
    }

    if (mode === "filter") {
      if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
      if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
      if (key.escape) return leaveMode();
      if (key.return) {
        if (highlighted) {
          leaveMode();
          props.onOpen(highlighted);
        } else {
          composer.clear();
          setMode("create");
        }
        return;
      }
      composer.handleKey(input, key);
      return;
    }

    // `←` and `esc` are the same door. On a list there is nothing for `←` to mean other than "out",
    // and reaching for it is the reflex a two-pane file browser trains.
    if (key.escape || key.leftArrow) return props.onBack();
    if (key.upArrow) return setSelected(clampIndex(cursor - 1, total));
    if (key.downArrow) return setSelected(clampIndex(cursor + 1, total));
    // `→` descends, the exact mirror of `←`.
    if (key.return || key.rightArrow) {
      if (highlighted) return props.onOpen(highlighted);
      return setMode("create");
    }
    if (input === "/") return setMode("filter");
    if (input === "n") return setMode("create");
    if (input === "x" && highlighted) return setMode("confirm");
    if (input === "a" && highlighted) return shelve(highlighted);
    // The shelf is a separate list rather than a dimmed section: an archived job is one you have
    // decided not to look at, and leaving it in the list you scan defeats archiving it.
    if (input === "s") {
      setSelected(0);
      return setView((current) => (current === "open" ? "archived" : "open"));
    }
    if (input === "?") return setShortcuts((open) => !open);
  });

  const trail = ["atlas", props.project.name];

  if (jobs === null) {
    return (
      <Screen header={<PageHeader trail={trail} canBack />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <PageHeader trail={trail} canBack right={headerRight({ view, query, rows, all })} />
      }
      footer={
        <ListFooter
          width={width}
          height={height}
          overlay={overlayFor({ mode, composer })}
          confirm={
            mode === "confirm" && highlighted ? (
              <ConfirmBar
                question={`delete “${highlighted.title}”?`}
                detail={deletionCost(highlighted)}
              />
            ) : null
          }
          hints={mode === "browse" ? (view === "archived" ? ARCHIVED_HINTS : HINTS) : undefined}
          shortcuts={shortcuts}
          error={error}
        />
      }
    >
      <ListEmpty
        show={all.length === 0 && mode !== "create"}
        headline={view === "archived" ? "Nothing archived." : "No jobs yet."}
        hint={
          view === "archived"
            ? "Archiving hides a job. Nothing is closed and nothing is deleted."
            : "A job is one unit of work plus a shared /context folder."
        }
      />
      <NoMatch show={all.length > 0 && rows.length === 0} query={query} />

      {rows.map((job, index) => (
        <JobListRow
          key={job.id}
          job={job}
          selected={index === cursor}
          layout={layout}
          frame={frame}
          runningThreadIds={running}
        />
      ))}

      {canCreate ? (
        <box flexDirection="column">
          <text> </text>
          <AddRow selected={cursor >= rows.length} label="+ new job" />
        </box>
      ) : null}
    </Screen>
  );
}
