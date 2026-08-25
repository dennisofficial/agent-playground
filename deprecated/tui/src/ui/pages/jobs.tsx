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
import type { JobEntry } from "../../domain/job-groups.js";
import { clampIndex, matchesQuery } from "../../domain/list-nav.js";
import { jobSummary, jobsLayout } from "../../domain/jobs-list.js";
import { EJobEntry, selectableEntries, sortClaimedLast } from "../../domain/job-groups.js";
import { EClaimState } from "../../domain/claim.js";
import { claimService } from "../hooks/use-claim.js";
import { ListFooter } from "../components/list-footer.js";
import { JobEntries } from "../components/job-entries.js";
import { useJobEntries } from "../hooks/use-job-entries.js";
import { useJobsActions } from "../hooks/use-jobs-actions.js";
import { useProjectAttention } from "../hooks/use-project-attention.js";
import { AddRow, ListEmpty, NoMatch } from "../components/list-parts.js";
import { PageHeader } from "../components/page-header.js";
import { Screen } from "../components/screen.js";
import { useComposer } from "../hooks/use-composer.js";
import { useJobsKeys } from "../hooks/use-jobs-keys.js";
import { useServiceJobIds } from "../hooks/use-job-services.js";
import { usePendingProposals } from "../hooks/use-pending-proposals.js";
import { useRunningThreads, useTick } from "../hooks/use-conversation.js";
import { useServices } from "../services.js";
import { theme } from "../theme.js";
import {
  ACTION_LABELS,
  actionFor,
  confirmFor,
  EJobAction,
  headerRight,
  hintsFor,
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
  /**
   * `n` and `+ new job` — a blank conversation, and no job until a message is sent into it.
   *
   * `adopt` is `⏎` on a worktree with no jobs: the same blank page, but the job it creates will stand
   * in that worktree instead of the project path.
   */
  onNew: (adopt?: { branch: string; workspacePath: string }) => void;
  onProjects: () => void;
  onBack: () => void;
}): React.ReactNode {
  const { workspaceService, attentionService, worktreeService } = useServices();
  const projectId = props.project?.id ?? null;
  // One project, or all of them. Read by nearly everything below — the header's `‹`, the verbs, the
  // hint line — because scoped and unscoped are the same page and this is the whole difference.
  const scoped = props.project !== null;
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
  // Polled rather than pushed — the registry has no notify machinery. The hook hands back the same
  // Set object while the membership holds, so the list only repaints when a service actually moves.
  const serviceJobIds = useServiceJobIds();

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
  const canCreate = view === "open" && scoped;
  const layout = jobsLayout(width);

  // Project headers unscoped, worktree headers inside one repository — see `useJobEntries`.
  const entries = useJobEntries({
    jobs: rows,
    project: props.project,
    filtering: query.length > 0,
  });
  const projectAttention = useProjectAttention(running);

  // The cursor walks JOBS and empty worktrees, in draw order. Derived from the entries rather than
  // counted off `rows`, because a worktree with nothing under it is now a stop of its own and
  // `rows.length` stopped being the number of places the cursor can be.
  const stops = useMemo(() => selectableEntries(entries), [entries]);
  // The one row past the end: a new job here, or — with nothing in any project — the switcher, so
  // the emptiest the app ever looks still has a door on it.
  const action = actionFor({ view, canCreate, empty: all.length === 0 });
  const total = stops.length + (action ? 1 : 0);
  const cursor = clampIndex(selected, total);
  const highlighted = stops[cursor];

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || jobs === null) return;
    restored.current = true;
    // Found among the STOPS, not among the jobs: with worktree headings interleaved, a job's position
    // in the query result is no longer its position under the cursor.
    const index = props.focusId
      ? stops.findIndex(
          (entry) =>
            entry.kind === EJobEntry.job && entry.job.id === props.focusId,
        )
      : -1;
    if (index >= 0) setSelected(index);
  }, [jobs, stops, props.focusId]);

  const leaveMode = useCallback(() => {
    setMode("browse");
    composer.clear();
  }, [composer]);

  const { handleNew, handleNewIn, releaseWorktree, remove, shelve } =
    useJobsActions({
      project: props.project,
      view,
      leaveMode,
      reload,
      onError: setError,
      onNew: props.onNew,
    });

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
    action,
    leaveMode,
    onNew: handleNew,
    onNewIn: handleNewIn,
    remove,
    releaseWorktree,
    shelve,
    setShortcuts,
    onOpen: props.onOpen,
    onProjects: props.onProjects,
    onBack: props.onBack,
  });

  // No leading "atlas" segment. Every page is atlas, so it identified nothing and cost the line two
  // segments — and in a repository that happens to be called atlas it drew `atlas › atlas`.
  //
  // `‹` follows the SCOPE, because widening is the only thing `←` does here: on one project it goes
  // to every job, and on every job there is nowhere further out to go.
  const trail = [props.project ? props.project.name : "all jobs"];

  if (jobs === null) {
    return (
      <Screen header={<PageHeader trail={trail} canBack={scoped} />}>
        <text fg={theme.dim}>loading…</text>
      </Screen>
    );
  }

  return (
    <Screen
      header={
        <PageHeader
          trail={trail}
          canBack={scoped}
          right={headerRight({ view, query, rows, all })}
        />
      }
      footer={
        <ListFooter
          width={width}
          height={height}
          overlay={overlayFor({ mode, composer })}
          confirm={mode === "confirm" ? confirmFor(highlighted) : null}
          hints={
            mode === "browse"
              ? hintsFor({ view, canCreate, highlighted, action })
              : undefined
          }
          shortcuts={shortcuts}
          error={error}
        />
      }
    >
      {/* Three empties, not one. The shelf is empty because you have put nothing away; a project is
          empty because you have not started here yet; the unscoped list is empty because there is
          nothing anywhere, and that one is a first run — the only one that has to say where to
          begin, because the `+ new job` row it would normally point at cannot exist. */}
      <ListEmpty
        show={all.length === 0}
        headline={
          view === "archived"
            ? "Nothing archived."
            : scoped
              ? "No jobs yet."
              : "Nothing running anywhere."
        }
        hint={
          view === "archived"
            ? "Archiving hides a job. Nothing is closed and nothing is deleted."
            : scoped
              ? "A job is one unit of work plus a shared /context folder."
              : "A job is one unit of work in one project — pick where to start."
        }
      />
      <NoMatch show={all.length > 0 && rows.length === 0} query={query} />

      <JobEntries
        entries={entries}
        cursor={cursor}
        layout={layout}
        frame={frame}
        runningThreadIds={running}
        proposals={proposals}
        isClaimed={isClaimed}
        projectAttention={projectAttention}
        serviceJobIds={serviceJobIds}
      />

      {action ? (
        <box flexDirection="column">
          <text> </text>
          <AddRow
            selected={cursor >= stops.length}
            label={ACTION_LABELS[action]}
          />
        </box>
      ) : null}
    </Screen>
  );
}
