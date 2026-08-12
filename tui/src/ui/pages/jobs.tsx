import { useTerminalDimensions } from "@opentui/react";
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
import {
  EJobEntry,
  groupJobs,
  sortClaimedLast,
} from "../../domain/job-groups.js";
import { EClaimState } from "../../domain/claim.js";
import { claimService } from "../hooks/use-claim.js";
import { ConfirmBar } from "../components/confirm-bar.js";
import { ListFooter } from "../components/list-footer.js";
import { JobGroupHeader, JobListRow } from "../components/job-list.js";
import { useProjectAttention } from "../hooks/use-project-attention.js";
import { AddRow, ListEmpty, NoMatch } from "../components/list-parts.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer } from "../hooks/use-composer.js";
import { useJobsKeys } from "../hooks/use-jobs-keys.js";
import { usePendingProposals } from "../hooks/use-pending-proposals.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";
import {
  ARCHIVED_HINTS,
  HINTS,
  UNSCOPED_HINTS,
  headerRight,
  overlayFor,
  type Mode,
  type View,
} from "./jobs-chrome.js";

/**
 * Page 1 — every job, or one project's.
 *
 * `project` null is the unscoped list: every job you have, grouped by project, which is what you
 * get launching Atlas anywhere that is not a repository. It is not an error state and not a picker
 * you pass through — it is the entry point, and the scoped list is the same page with the headers
 * collapsed away.
 */
export function JobsPage(props: {
  project: ProjectRow | null;
  /** The job last opened — the cursor lands on it when you come back, not on row zero. */
  focusId?: string | undefined;
  onOpen: (job: JobRow) => void;
  /** `n` and `+ new job` — a blank conversation, and no job until a message is sent into it. */
  onNew: () => void;
  onProjects: () => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService, attentionService } = useServices();
  const projectId = props.project?.id ?? null;
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [claims, setClaims] = useState<Map<string, EClaimState>>(new Map());
  const [view, setView] = useState<View>("open");
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [shortcuts, setShortcuts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { width, height } = useTerminalDimensions();
  // A filter, never a draft: one line.
  const composer = useComposer("", { singleLine: true });

  // Which of these jobs has an agent working in it right now. Without this a job you walked away
  // from is indistinguishable from an idle one, and the whole point of leaving it running is lost.
  const running = useRunningThreads();
  const { frame } = useTick(running.length > 0);
  // Which jobs owe you a keypress. The rows read it per job; the group headers roll it up on their
  // own inside `useProjectAttention`, so there is no third table anywhere.
  const proposals = usePendingProposals(running);

  const reload = useCallback(async () => {
    const next =
      view === "archived"
        ? await attentionService.listArchivedJobs(projectId)
        : await workspaceService.listJobs(projectId);
    setJobs(next);
    // One stat and one signal per row, on the same beat as the list itself. Cheap enough to do
    // eagerly, and doing it in the render path instead would put a filesystem read behind a paint.
    setClaims(claimService.statesFor(next.map((job) => job.id)));
  }, [attentionService, workspaceService, projectId, view]);

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
  const isClaimed = useCallback(
    (job: JobRow) => claims.get(job.id) === EClaimState.held,
    [claims],
  );
  const rows = useMemo(
    // The phase and the role left the row when the status column became the verb you owe, but they
    // are still the most natural thing to type when hunting for a job by what it was doing.
    () =>
      sortClaimedLast({
        jobs: all.filter((job) => matchesQuery(query, job.title, jobSummary(job))),
        isClaimed,
      }),
    [all, query, isClaimed],
  );
  // The shelf has no `+ new job`: a job you create is a job you are working on, by definition.
  // Neither does the unscoped list — "new job" needs somewhere to put it, and standing in `~`
  // there is no here to create it in. `cd` into a repo, or press `p`.
  const canCreate = view === "open" && props.project !== null;
  const total = rows.length + (canCreate ? 1 : 0);
  const layout = jobsLayout(width);

  // Grouping follows the SCOPE, never the row count: a list that grew a second project mid-session
  // must not silently reorganise itself around you.
  const entries = useMemo(
    () => groupJobs({ jobs: rows, grouped: props.project === null }),
    [rows, props.project],
  );
  const projectAttention = useProjectAttention(running);

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

  // No create mode: `n` leaves this page for a blank conversation, and the job is created by the
  // first message sent there. The title prompt that used to live here was ceremony charged before
  // anyone knew whether there was a job at all — and it was injected as the opening message anyway.
  const handleNew = useCallback(() => {
    leaveMode();
    props.onNew();
  }, [leaveMode, props]);

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

  useJobsKeys({
    mode,
    setMode,
    view,
    setView,
    composer,
    cursor,
    total,
    setSelected,
    highlighted,
    canCreate,
    leaveMode,
    onNew: handleNew,
    remove,
    shelve,
    setShortcuts,
    onOpen: props.onOpen,
    onProjects: props.onProjects,
    onBack: props.onBack,
  });

  // Unscoped, the trail is just the app: there is no one project to name, and naming none of them
  // is more honest than naming all of them.
  const trail = props.project ? ["atlas", props.project.name] : ["atlas"];

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
          hints={
            mode === "browse"
              ? view === "archived"
                ? ARCHIVED_HINTS
                : canCreate
                  ? HINTS
                  : UNSCOPED_HINTS
              : undefined
          }
          shortcuts={shortcuts}
          error={error}
        />
      }
    >
      <ListEmpty
        show={all.length === 0}
        headline={view === "archived" ? "Nothing archived." : "No jobs yet."}
        hint={
          view === "archived"
            ? "Archiving hides a job. Nothing is closed and nothing is deleted."
            : "A job is one unit of work plus a shared /context folder."
        }
      />
      <NoMatch show={all.length > 0 && rows.length === 0} query={query} />

      {entries.map((entry, position) =>
        entry.kind === EJobEntry.header ? (
          <box key={`h:${entry.projectId}`} flexDirection="column">
            {/* Air above every group but the first — the rule that separates them is whitespace,
                because a list this dense cannot afford a second kind of line. */}
            {position > 0 ? <text> </text> : null}
            <JobGroupHeader
              name={entry.projectName}
              attention={projectAttention(entry.projectId)}
              frame={frame}
            />
          </box>
        ) : (
          <JobListRow
            key={entry.job.id}
            job={entry.job}
            selected={entry.index === cursor}
            layout={layout}
            frame={frame}
            runningThreadIds={running}
            proposalThreadIds={proposals.get(entry.job.id) ?? []}
            claimed={isClaimed(entry.job)}
          />
        ),
      )}

      {canCreate ? (
        <box flexDirection="column">
          <text> </text>
          <AddRow selected={cursor >= rows.length} label="+ new job" />
        </box>
      ) : null}
    </Screen>
  );
}
