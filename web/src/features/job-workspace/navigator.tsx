"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Pause,
  Pencil,
  RotateCw,
  Server,
  ShieldCheck,
  SquareTerminal,
  TicketIcon,
  Trash2,
} from "lucide-react";
import { Dot, KindBadge, StatusPie } from "@/components/ui/badges";
import { STATUS_META } from "@/lib/api/status";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { pipelineJob } from "@/lib/api/job-api";
import { useRetryJob, useServices } from "@/lib/api/job-queries";
import { useJobTickets } from "@/lib/api/tickets-queries";
import {
  Divider,
  PipelineTree,
  TasksBody,
  haltThreadIdx,
} from "./pipeline-tree";
import { codexReviewNode } from "./codex-review";
import {
  NavigatorApproveButton,
  NavigatorShipButton,
} from "./spec-approval";
import { pipelineMainTasks } from "@/lib/api/types";
import { useLiveTurn } from "@/lib/api/job-stream";
import { overlayLiveTasks } from "./live-tasks";
import type {
  ContextFile,
  PipelineJob,
  PipelineState,
  JobContext,
  JobKind,
  JobStatus,
  TaskItem,
} from "@/lib/api/types";
import type { JobRef } from "@/lib/api/job-api";
import { PlanReviewRow } from "@/features/job-workspace/plan-review-row";
import { JobMenu } from "@/features/job-workspace/job-menu";
import { FolderRow } from "@/features/job-workspace/folder-row";

/**
 * PR-row glyph for the navigator header — mirrors the sidebar's `prGlyph` (GitHub color convention) so the
 * two never disagree: merged → purple, closed → red, open+conflict → amber, open → green. Reads the same
 * `pr_state` / `pr_mergeable` columns the sidebar does. `label` is the short word after `PR #NN · `.
 */
function prNavGlyph(
  state: PipelineJob["prState"],
  mergeable: PipelineJob["prMergeable"],
): { Icon: typeof GitPullRequest; color: string; label: string } {
  if (state === "merged")
    return { Icon: GitMerge, color: "var(--purple)", label: "merged" };
  if (state === "closed")
    return { Icon: GitPullRequestClosed, color: "var(--red)", label: "closed" };
  if (mergeable === "dirty")
    return { Icon: GitPullRequest, color: "var(--amber)", label: "conflict" };
  return { Icon: GitPullRequest, color: "var(--green)", label: "open" };
}

export interface JobMeta {
  title: string;
  kind: JobKind;
  status: JobStatus;
  orgName: string;
  /** Org swatch fill — neutral grey now (handoff). */
  orgColor: string;
  repoName: string;
  tracker?: string;
}

/**
 * The 288px JOB navigator (design "Atlas Workspace HiFi") — ONE constant skeleton for the job's whole
 * lifecycle: a STICKY header (kind · status · title · org/repo · branch · PR · changes) over three scrolling
 * regions — THREADS (the Main planning lane + each build lane), OUTPUTS (specs / artifacts / generated), and
 * PORTS (the sandbox's live dev servers). The header stays pinned; only the regions scroll. The skeleton
 * never restructures; only the signals inside change (dot color, dimming, the selected row, per-region notes).
 *
 * "Job" is the operator-facing name for what the API still calls a thread; a job's lanes ("Threads") are the
 * Main conversation + the build threads. PORTS is a design-stage mock (no backend port-exposure yet) — kept
 * behind {@link PORTS_MOCK} so it is trivial to wire to real sandbox ports later.
 */
export function Navigator({
  meta,
  pipeline,
  context,
  contextLoading,
  laneNode,
  detailNode,
  jobRef,
  approveValue,
  shipValue,
  onConversation,
  onSelectNode,
  onRename,
  onDelete,
  deleting,
  directBuild,
}: {
  meta: JobMeta;
  pipeline: PipelineState | undefined;
  /** The job's `/context` files (specs + generated + artifacts) — feeds the OUTPUTS region. */
  context: JobContext | undefined;
  contextLoading?: boolean;
  /** The LEFT pane's open THREADS lane (`?lane=`; `null` = Main) — highlighted ORANGE. */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`; OUTPUT / port / doc) — highlighted BLUE. */
  detailNode: string | null;
  /** The open job — for the in-place "Approve plan" callout. */
  jobRef: JobRef;
  /** The approval card's verbatim approve `value`, when the job is awaiting approval (else ''). Drives
   *  the navigator approval callout. */
  approveValue: string;
  /** The ship card's verbatim `{ jobId }` value, when the job is awaiting ship review (else ''). Drives
   *  the navigator ship button + callout. */
  shipValue: string;
  /** Clears the detail-pane selection (the Main lane / the state banners' recovery actions). */
  onConversation: () => void;
  onSelectNode: (node: string) => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  deleting?: boolean;
  /** True when the awaiting approval is a direct build — flips the approve CTA to "Approve Direct Build". */
  directBuild?: boolean;
}) {
  const job = pipelineJob(pipeline);
  const branch = job?.featureBranch ?? job?.baseBranch ?? undefined;
  // DRIFT: the agent switched the sandbox HEAD to a branch other than the host-named featureBranch. Surfaced
  // (never blocked) — the live branch is what actually ships. Null when there's no divergence to show.
  const drift =
    job?.currentBranch && job.currentBranch !== job.featureBranch
      ? job.currentBranch
      : null;
  // "Has a PR" mirrors the sidebar's signal — the observed PR lifecycle (`prState`), NOT `prUrl`. A closed
  // PR (or a partially-recorded row) can carry `prState`/`prNumber` with a null `prUrl`; gating on `prUrl`
  // would then say "No PR yet" while the sidebar shows the closed glyph. The URL only gates the link-out.
  const hasPr = Boolean(job?.prState);
  // We can't read a real +/− line stat (no diff endpoint), but a job that hasn't built anything yet
  // (planning / awaiting / triaging) plainly has no changes — show a muted "—" on the Changes row then.
  const noChanges =
    !hasPr &&
    meta.status !== "done" &&
    meta.status !== "running" &&
    meta.status !== "awaiting_ship_review" &&
    meta.status !== "paused" &&
    meta.status !== "failed";
  const [editing, setEditing] = useState(false);

  // Tickets Atlas raised FROM this job — the header "Tickets raised" entry appears only once there's ≥1.
  const { data: raisedTickets = [] } = useJobTickets(jobRef);

  const st = meta.status;

  return (
    <div
      className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border"
      style={{
        background: "color-mix(in srgb, var(--panel) 35%, transparent)",
      }}
    >
      {/* ── STICKY header (compact) ─────────────────────────────────────────────────────────── */}
      <div className="flex-none border-b border-border px-4 pb-2.5 pt-3">
        <div className="mb-1.5 flex items-center gap-2">
          <KindBadge kind={meta.kind} />
          <span
            className="flex items-center gap-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.05em]"
            style={{ color: STATUS_META[st].color }}
          >
            <StatusPie status={st} size={13} />
            {STATUS_META[st].label}
          </span>
          <div className="flex-1" />
          {onDelete || onRename ? (
            <JobMenu
              onStartRename={onRename ? () => setEditing(true) : undefined}
              onDelete={onDelete}
              deleting={deleting}
            />
          ) : null}
        </div>
        {editing && onRename ? (
          <input
            autoFocus
            defaultValue={meta.title}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = e.currentTarget.value.trim();
                if (v && v !== meta.title) onRename(v);
                setEditing(false);
              } else if (e.key === "Escape") {
                setEditing(false);
              }
            }}
            onBlur={() => setEditing(false)}
            className="w-full rounded border border-border-2 bg-surface px-1.5 py-0.5 font-disp text-[15px] font-semibold text-text outline-none focus:border-accent"
            aria-label="Job title"
          />
        ) : (
          <div className="font-disp text-[15px] font-semibold leading-tight tracking-[-0.01em] text-text">
            {meta.title}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-2">
          <span
            className="h-[7px] w-[7px] shrink-0 rounded-sm"
            style={{ background: meta.orgColor }}
          />
          <span className="font-mono text-[9.5px] text-dim">
            {meta.orgName}
          </span>
          <span className="text-[9px] text-border-2">/</span>
          <span className="font-mono text-[9.5px] font-semibold">
            {meta.repoName}
          </span>
        </div>
        {branch ? (
          <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
            <GitBranch
              size={10}
              className="shrink-0"
              style={drift ? { color: "var(--amber)" } : undefined}
            />
            <span
              className="flex-1 truncate font-mono text-[9.5px] text-dim"
              title={drift ? `drifted from ${branch} → ${drift}` : undefined}
            >
              {drift ? (
                <>
                  <span className="text-faint line-through">{branch}</span>
                  <span className="px-1 text-faint">→</span>
                  <span style={{ color: "var(--amber)" }}>{drift}</span>
                </>
              ) : (
                branch
              )}
            </span>
            {meta.tracker ? (
              <span className="shrink-0 font-mono text-[9px] text-blue">
                {meta.tracker} ↗
              </span>
            ) : null}
          </div>
        ) : meta.tracker ? (
          <div className="mt-1.5 font-mono text-[9.5px] text-blue">
            {meta.tracker} ↗
          </div>
        ) : null}
        {/* PR — links out once opened, muted resting state until then. */}
        <div className="mt-1 flex items-center gap-1.5 px-1">
          {hasPr ? (
            (() => {
              const { Icon, color, label } = prNavGlyph(
                job!.prState,
                job!.prMergeable,
              );
              const text = `${job!.prNumber != null ? `PR #${job!.prNumber}` : "pull request"} · ${label}`;
              // Link out only when we actually have the PR url; otherwise show the same status inline.
              return job!.prUrl ? (
                <a
                  href={job!.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex flex-1 items-center gap-1.5 rounded py-0.5 hover:bg-surface-2"
                >
                  <Icon
                    size={11}
                    strokeWidth={2}
                    style={{ color }}
                    className="shrink-0"
                  />
                  <span
                    className="flex-1 font-mono text-[9.5px] font-semibold"
                    style={{ color }}
                  >
                    {text}
                  </span>
                  <ArrowUpRight size={11} className="text-faint" />
                </a>
              ) : (
                <div className="flex flex-1 items-center gap-1.5 py-0.5">
                  <Icon
                    size={11}
                    strokeWidth={2}
                    style={{ color }}
                    className="shrink-0"
                  />
                  <span
                    className="flex-1 font-mono text-[9.5px] font-semibold"
                    style={{ color }}
                  >
                    {text}
                  </span>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-1 items-center gap-1.5 py-0.5">
              <GitPullRequest size={11} className="shrink-0 text-faint" />
              <span className="flex-1 font-mono text-[9.5px] text-faint">
                No PR yet
              </span>
            </div>
          )}
        </div>
        {/* Changes — always available; opens the accumulated diff in the detail pane. */}
        <button
          type="button"
          onClick={() => onSelectNode("diff")}
          className={cn(
            "-mx-4 mt-1 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2",
            detailNode === "diff" && "nav-selected-blue",
          )}
        >
          <span className="w-3.5 shrink-0 text-center font-mono text-[13px] font-bold text-blue">
            ±
          </span>
          <span className="flex-1 text-[11px] font-semibold text-dim">
            Changes
          </span>
          {noChanges ? (
            <span className="font-mono text-[9px] text-faint">—</span>
          ) : null}
        </button>
        {/* Tickets raised — appears only once Atlas has captured out-of-scope work from this job; opens the
            standing "Tickets raised" list in the detail pane. */}
        {raisedTickets.length > 0 ? (
          <button
            type="button"
            onClick={() => onSelectNode("tickets")}
            className={cn(
              "-mx-4 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2",
              detailNode === "tickets" && "nav-selected-blue",
            )}
          >
            <TicketIcon size={13} className="w-3.5 shrink-0 text-accent" />
            <span className="flex-1 text-[11px] font-semibold text-dim">
              Tickets raised
            </span>
            <span className="font-mono text-[9px] text-faint">
              {raisedTickets.length}
            </span>
          </button>
        ) : null}
        {/* Approve — pinned as the last header item while the plan is awaiting approval. */}
        {st === "awaiting_approval" && approveValue ? (
          <div className="mt-2">
            <NavigatorApproveButton
              jobRef={jobRef}
              value={approveValue}
              directBuild={directBuild}
            />
          </div>
        ) : null}
        {/* Ship it — the SECOND human gate, pinned the same way once the build + master review finish. */}
        {st === "awaiting_ship_review" && shipValue ? (
          <div className="mt-2">
            <NavigatorShipButton jobRef={jobRef} value={shipValue} />
          </div>
        ) : null}
      </div>

      {/* ── scroll body — the constant skeleton (THREADS · OUTPUTS · PORTS). No horizontal padding: rows
             carry their own px, so each is a full-width band (design "Atlas Workspace HiFi") and the
             selected `.nav-selected` band + left accent bar can run flush to the rail edge. ─────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto py-3">
        <StateBanner
          status={st}
          job={job}
          jobRef={jobRef}
          onConversation={onConversation}
        />

        {/* THREADS — the Main planning lane + each build lane, as an ACCORDION (design handoff "thread
            navigation"): selecting a thread opens its fold (state rail + wash + tasks/review agents) and
            collapses whichever was open. Selecting opens it in the LEFT pane. */}
        <MainLaneRow
          active={laneNode === null}
          running={st === "running" || st === "planning"}
          jobId={jobRef.jobId}
          durableTasks={pipelineMainTasks(pipeline)}
          onClick={onConversation}
        />
        {/* CODEX REVIEW — the plan-review dialogue as its own first-class navigator row (Main communicates
            with it). Present once a review has run; opens the `codex-review:<jobId>` lane in the LEFT pane. */}
        {job?.planReview ? (
          <PlanReviewRow
            jobId={jobRef.jobId}
            status={job.planReview.status}
            laneNode={laneNode}
            onSelectNode={onSelectNode}
          />
        ) : null}
        <ThreadRows
          status={st}
          job={job}
          jobId={jobRef.jobId}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />

        {/* The whole-diff master review is now just another thread in the THREADS list above (rendered
            "Master review", no pinned region) — see the master-review-as-thread change. */}

        {/* OUTPUTS — specs / artifacts / generated, merged. Open in the RIGHT pane (blue highlight). */}
        <OutputsRegion
          status={st}
          context={context}
          loading={contextLoading}
          detailNode={detailNode}
          onSelectNode={onSelectNode}
        />

        {/* SERVICES — real atlas-svc supervised processes (dev servers Atlas brought up on demand). Open in
            the RIGHT pane (blue), which streams the process's captured log. */}
        <ServicesRegion
          jobRef={jobRef}
          detailNode={detailNode}
          onSelectNode={onSelectNode}
        />

        {/* PORTS — the sandbox's live dev servers (design-stage mock). Open in the RIGHT pane (blue). */}
        <PortsRegion detailNode={detailNode} onSelectNode={onSelectNode} />
      </div>
    </div>
  );
}

// ── THREADS: the Main lane + the build-lane tree ───────────────────────────────────────────────────

/** The Main planning lane — the job's brain conversation, the accordion's always-first row (the design's
 *  `active` thread: solid green dot, green rail + wash while it's the open lane). Active when no other
 *  lane is selected; its fold shows the brain session's OWN task list (`job.mainTasks`), with the live
 *  `main` lane folded on top so mid-turn task calls tick in realtime (see `live-tasks.ts`). */
function MainLaneRow({
  active,
  running,
  jobId,
  durableTasks,
  onClick,
}: {
  active: boolean;
  running: boolean;
  jobId: string;
  durableTasks: TaskItem[];
  onClick: () => void;
}) {
  const liveTurn = useLiveTurn(jobId);
  const tasks = overlayLiveTasks(durableTasks, liveTurn);
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <div
      className="border-l-[3px]"
      style={
        active
          ? {
              borderLeftColor: "var(--green)",
              background: "color-mix(in srgb, var(--green) 6%, transparent)",
            }
          : { borderLeftColor: "transparent", background: "transparent" }
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2 py-1.5 pl-1.5 pr-2 text-left transition hover:bg-surface-2"
      >
        <span className="grid h-[13px] w-[13px] shrink-0 place-items-center">
          <Dot color="var(--green)" pulse={running} size={9} />
        </span>
        <span
          className={cn(
            "flex-1 truncate text-[12px]",
            active ? "font-semibold text-text" : "font-medium text-dim",
          )}
        >
          Main
        </span>
        <span className="shrink-0 font-mono text-[8px] text-faint">
          {tasks.length > 0 ? `[${done}/${tasks.length}]` : "planning"}
        </span>
      </button>
      {active && tasks.length > 0 ? (
        <TasksBody tasks={tasks} done={done} total={tasks.length} />
      ) : null}
    </div>
  );
}

/** The build lanes under THREADS — one row per thread. The live/failed/done tree, the triage lane, or (pre-
 *  approval) the draft threads. Flows directly under the Main lane row (no section header); the first OUTPUTS
 *  sub-group divider below separates it from the outputs. Each thread's subitems are its live task list (the
 *  SDK task tools) — see {@link PipelineTree}; submit-plan shows only the threads (no steps). */
function ThreadRows({
  status,
  job,
  jobId,
  laneNode,
  onSelectNode,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  jobId: string;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  // Triaging — the autonomous lane: triage findings, not a build tree.
  if (status === "triaging") {
    return (
      <>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--green)" }}
          />
          <span className="flex-1 text-[11.5px] text-dim">
            Verified &amp; classified
          </span>
        </div>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span
            className="pulse-dot h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--slate)" }}
          />
          <span className="flex-1 text-[11.5px] text-text">
            1 decision parked for you
          </span>
        </div>
      </>
    );
  }

  // One renderer for every stage: running/done/failed threads expand to their live task list; pre-approval
  // drafts render as bare thread rows (dashed dots, no tasks). Empty (early planning) → the hero ghost row.
  if (!job || job.threads.length === 0) {
    return <BuildLanesEmpty />;
  }
  return (
    <PipelineTree
      job={job}
      status={status}
      jobId={jobId}
      laneNode={laneNode}
      onSelectNode={onSelectNode}
    />
  );
}

// ── OUTPUTS: specs / artifacts / generated, merged into one region ─────────────────────────────────

function OutputsRegion({
  status,
  context,
  loading,
  detailNode,
  onSelectNode,
}: {
  status: JobStatus;
  context: JobContext | undefined;
  loading?: boolean;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const specs = context?.specs ?? [];
  const generated = context?.generated ?? [];
  const artifacts = context?.artifacts ?? [];
  const triaging = status === "triaging";

  return (
    <>
      {/* OUTPUTS — no section header (flat list); the SPECS / ARTIFACTS / GENERATED sub-group dividers
          (and PORTS below) carry the labels. Open in the RIGHT pane (blue highlight). */}

      {/* SPECS — the plan files (plan.md, diagrams). An untrusted-seeded job keeps its provenance note. */}
      <OutputGroup
        label="SPECS"
        files={specs}
        prefix="spec"
        loading={loading}
        emptyIcon={<FileText size={13} />}
        emptyText={
          <>
            Waiting for{" "}
            <span className="font-mono text-[10px] text-dim">plan.md</span>
          </>
        }
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      >
        {triaging ? (
          <div
            className="mx-1.5 mb-1 rounded-md border border-l-2 px-3 py-2.5"
            style={{
              borderColor: "var(--border)",
              borderLeftColor: "var(--slate)",
              background: "var(--surface-2)",
            }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <GitPullRequest size={11} className="text-dim" />
              <span className="flex-1 font-mono text-[10px] font-semibold">
                github · workflow_run
              </span>
              <span
                className="rounded border px-1.5 py-px font-mono text-[8px] font-semibold"
                style={{
                  color: "var(--slate)",
                  background: "var(--slate-soft)",
                  borderColor: "var(--slate-line)",
                }}
              >
                UNTRUSTED
              </span>
            </div>
            <p className="text-[10.5px] leading-snug text-dim">
              An untrusted notification seeded this job.
            </p>
          </div>
        ) : null}
      </OutputGroup>

      {/* GENERATED — system-owned, read-only (decision-record.md). */}
      <OutputGroup
        label="GENERATED"
        files={generated}
        prefix="gen"
        generated
        loading={loading}
        emptyIcon={<Lock size={13} />}
        emptyText="Nothing generated yet"
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      />

      {/* ARTIFACTS — real output files (preview HTML, screenshots). Diff + PR live in the header. */}
      <OutputGroup
        label="ARTIFACTS"
        files={artifacts}
        prefix="artifact"
        loading={loading}
        emptyIcon={<ImageIcon size={13} />}
        emptyText="No screenshots or files yet"
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      />
    </>
  );
}

/** One OUTPUTS sub-group (SPECS / ARTIFACTS / GENERATED) — its header is ALWAYS shown; the body is the
 *  files, a loading row, or the section's own dashed empty row (handoff "Navigator Empty States": each
 *  section populates independently, so each owns its empty state). `children` renders above the files
 *  (the SPECS triaging provenance note). */
function OutputGroup({
  label,
  files,
  prefix,
  generated,
  loading,
  emptyIcon,
  emptyText,
  detailNode,
  onSelectNode,
  children,
}: {
  label: string;
  files: ContextFile[];
  prefix: "spec" | "artifact" | "gen";
  generated?: boolean;
  loading?: boolean;
  emptyIcon: ReactNode;
  emptyText: ReactNode;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const seededRef = useRef(false);
  useEffect(() => {
    // Files arrive async (empty on first render, populated once `/context` resolves) — seed the
    // "all folders collapsed" default the first time we actually have files, not before.
    if (!seededRef.current && files.length > 0) {
      seededRef.current = true;
      setCollapsed(allFolderPaths(buildFileTree(files)));
    }
  }, [files]);
  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <>
      <Divider
        label={label}
        count={files.length > 0 ? files.length : <ZeroCount />}
      />
      {children}
      {files.length > 0 ? (
        renderFileTree({
          node: buildFileTree(files),
          path: "",
          depth: 0,
          prefix,
          generated,
          detailNode,
          onSelectNode,
          collapsed,
          toggleFolder,
        })
      ) : loading ? (
        <LoadingRow label="Loading…" />
      ) : children ? null : (
        <EmptyRow icon={emptyIcon}>{emptyText}</EmptyRow>
      )}
    </>
  );
}

// ── SERVICES: atlas-svc supervised processes (real data — the process supervisor) ──────────────────

/** The build lanes' `atlas-svc run` processes — a DURABLE snapshot (marker files), not a live liveness
 *  check (the host can't see into the container's PID namespace). Rows never claim "running" outright;
 *  a pulsing dot is only a heuristic ("its log wrote recently"), never a guarantee — see `ServiceInfo`. */
function ServicesRegion({
  jobRef,
  detailNode,
  onSelectNode,
}: {
  jobRef: JobRef;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const { data, isLoading } = useServices(jobRef);
  const services = data?.services ?? [];

  return (
    <>
      <Divider
        label="SERVICES"
        count={services.length > 0 ? services.length : <ZeroCount />}
      />
      {services.length > 0 ? (
        services.map((s) => {
          const node = `service:${s.id}`;
          const active = detailNode === node;
          const recentlyActive =
            s.logUpdatedAt != null &&
            Date.now() - Date.parse(s.logUpdatedAt) < 15_000;
          // Live liveness drives the dot: accent = running (pulse only while its log is actively writing),
          // faint = stopped, slate = unknown/indeterminate. A stopped row also dims its label.
          const dotColor =
            s.status === "running"
              ? "var(--accent)"
              : s.status === "stopped"
                ? "var(--faint)"
                : "var(--slate)";
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectNode(node)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition hover:bg-surface-2",
                active && "nav-selected-blue",
              )}
            >
              <Dot
                color={dotColor}
                pulse={s.status === "running" && recentlyActive}
                size={9}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[11px] font-semibold",
                    s.status === "stopped" ? "text-faint" : "text-text",
                  )}
                >
                  {s.name}
                </span>
                <span className="block truncate font-mono text-[8px] text-faint">
                  {s.cmd || "atlas-svc"}
                </span>
              </span>
            </button>
          );
        })
      ) : isLoading ? (
        <LoadingRow label="Loading…" />
      ) : (
        <EmptyRow icon={<SquareTerminal size={13} />}>
          No services running yet
        </EmptyRow>
      )}
    </>
  );
}

// ── PORTS: the sandbox's live dev servers (design-stage mock) ──────────────────────────────────────

/** Whether to render the PORTS region. Mock-only for now — there is no backend port-exposure yet (the
 *  Docker port-mapping plumbing exists but is unused). Flip the data source here when it lands. */
const PORTS_MOCK = true;

interface PortVM {
  id: string;
  /** `W` web app · `S` server. */
  tag: "W" | "S";
  name: string;
  meta: string;
}

const MOCK_PORTS: PortVM[] = [
  { id: "billing", tag: "W", name: "Billing UI", meta: ":3000 · web app" },
  { id: "admin", tag: "W", name: "Admin", meta: ":3002 · web app" },
  { id: "api", tag: "S", name: "API server", meta: ":8080 · server" },
];

function PortsRegion({
  detailNode,
  onSelectNode,
}: {
  detailNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  if (!PORTS_MOCK) return null;
  const ports = MOCK_PORTS;
  return (
    <>
      {/* PORTS — the sandbox's live dev servers. Same inline-divider style as the OUTPUTS sub-groups; the
          "N live" green indicator rides the count slot (a plain muted 0 while nothing is exposed). */}
      <Divider
        label="PORTS"
        count={
          ports.length > 0 ? (
            <span className="flex items-center gap-1 font-mono text-[8px] font-semibold text-green">
              <span
                className="pulse-dot h-[5px] w-[5px] rounded-full"
                style={{ background: "var(--green)" }}
              />
              {ports.length} live
            </span>
          ) : (
            <ZeroCount />
          )
        }
      />
      {ports.length === 0 ? (
        <EmptyRow icon={<Globe size={13} />}>No ports exposed yet</EmptyRow>
      ) : null}
      {ports.map((p) => {
        const node = `port:${p.id}`;
        const active = detailNode === node;
        const web = p.tag === "W";
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectNode(node)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition hover:bg-surface-2",
              active && "nav-selected-blue",
            )}
          >
            <span
              className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px]"
              style={{
                color: web ? "var(--blue)" : "var(--green)",
                background: web
                  ? "color-mix(in srgb, var(--blue) 13%, transparent)"
                  : "var(--green-soft)",
              }}
            >
              {web ? <Globe size={11} /> : <Server size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-semibold text-text">
                {p.name}
              </span>
              <span className="block truncate font-mono text-[8px] text-faint">
                {p.meta}
              </span>
            </span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background: "var(--green)",
                boxShadow:
                  "0 0 0 3px color-mix(in srgb, var(--green) 16%, transparent)",
              }}
            />
          </button>
        );
      })}
    </>
  );
}

// ── state banners (failed / paused / awaiting) ─────────────────────────────────────────────────────

function StateBanner({
  status,
  job,
  jobRef,
  onConversation,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  jobRef: JobRef;
  onConversation: () => void;
}) {
  const retry = useRetryJob(jobRef);
  // Re-drive the halted build, then drop to the conversation to watch it resume.
  const onRetry = () => {
    retry.mutate(undefined, { onSuccess: onConversation });
  };
  if (status === "failed") {
    const haltNo = job ? haltSectionNo(job) : null;
    return (
      <div
        className="mx-1.5 my-1 rounded-md border px-3 py-2.5"
        style={{
          borderColor: "var(--red-line)",
          background: "var(--red-soft)",
        }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <AlertTriangle size={11} className="text-red" />
          <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-red">
            HALTED{haltNo ? ` · §${haltNo}` : ""}
          </span>
        </div>
        <p className="text-[10.5px] leading-snug text-dim">
          The run stopped — read the conversation for the halt, then steer or
          retry.
        </p>
        <div className="mt-2 flex gap-1.5">
          <BannerBtn
            tone="red"
            icon={<RotateCw size={10} />}
            label={retry.isPending ? "Retrying…" : "Retry"}
            onClick={onRetry}
            disabled={retry.isPending}
          />
          <BannerBtn tone="neutral" label="Revert" onClick={onConversation} />
        </div>
      </div>
    );
  }
  if (status === "paused") {
    return (
      <div
        className="mx-1.5 my-1 rounded-md border border-l-2 px-3 py-2.5"
        style={{
          borderColor: "var(--border)",
          borderLeftColor: "var(--faint)",
          background: "var(--surface-2)",
        }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <Pause size={11} className="text-dim" />
          <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-dim">
            SESSION SAVED
          </span>
        </div>
        <p className="text-[10.5px] leading-snug text-dim">
          The live session is held — reply to resume the same session.
        </p>
        <div className="mt-2 flex gap-1.5">
          <BannerBtn
            tone="accent"
            icon={<RotateCw size={10} />}
            label={retry.isPending ? "Resuming…" : "Re-ping"}
            onClick={onRetry}
            disabled={retry.isPending}
          />
        </div>
      </div>
    );
  }
  return null;
}

function haltSectionNo(job: PipelineJob): number | null {
  const idx = haltThreadIdx(job.threads);
  return idx === -1 ? null : idx + 1;
}

function BannerBtn({
  tone,
  icon,
  label,
  onClick,
  disabled,
}: {
  tone: "red" | "accent" | "neutral";
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const style =
    tone === "red"
      ? {
          color: "var(--red)",
          background: "var(--red-soft)",
          borderColor: "var(--red-line)",
        }
      : tone === "accent"
        ? {
            color: "var(--accent)",
            background: "var(--accent-soft)",
            borderColor: "var(--accent-line)",
          }
        : {
            color: "var(--dim)",
            background: "transparent",
            borderColor: "var(--border-2)",
          };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[10px] font-semibold disabled:opacity-50"
      style={style}
    >
      {icon}
      {label}
    </button>
  );
}

// ── empty states (design handoff "Navigator Empty States") ─────────────────────────────────────────

/** A section's dashed empty-placeholder row — 13px faint icon + short muted copy, deliberately
 *  NON-interactive (no hover, no click; the handoff's "2a" treatment). Each section renders its own,
 *  independently of its siblings. */
function EmptyRow({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-2 flex items-center gap-2 rounded-[9px] border border-dashed border-border-2 px-2.5 py-[7px]">
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted">
        {children}
      </span>
    </div>
  );
}

/** The muted `0` a section divider trails with while it's empty (vs the faint real count). */
function ZeroCount() {
  return <span className="text-border-2">0</span>;
}

/** The THREADS hero empty state — a ghost skeleton of the first build lane over a one-line teach caption.
 *  Shown from job creation until the approved plan creates real threads. */
function BuildLanesEmpty() {
  return (
    <div className="mx-2 mb-1 mt-2 flex flex-col gap-1.5">
      <div
        className="flex items-center gap-2 rounded-[9px] border border-dashed border-border-2 px-2.5 py-[7px]"
        style={{
          background: "color-mix(in srgb, var(--surface-2) 60%, transparent)",
        }}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-border-2" />
        <span className="h-2 flex-1 rounded bg-surface-3" />
        <span className="h-2 w-6 shrink-0 rounded bg-surface-3" />
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-dim">
        No build lanes yet — approve the plan and Atlas splits the work into
        lanes here.
      </p>
    </div>
  );
}

// ── small primitives ────────────────────────────────────────────────────────────────────────────

function FileRow({
  icon,
  name,
  dim,
  active,
  onClick,
  note,
  indent = 0,
}: {
  icon: ReactNode;
  name: string;
  dim?: boolean;
  active?: boolean;
  onClick?: () => void;
  note?: { text: string; pulse?: boolean };
  indent?: number;
}) {
  const body = (
    <>
      <span className="shrink-0">{icon}</span>
      <span
        className={`flex-1 truncate font-mono text-[11px] ${dim ? "text-dim" : ""}`}
      >
        {name}
      </span>
      {note ? (
        <span
          className={`font-mono text-[8px] ${note.pulse ? "pulse-dot text-accent" : "text-faint"}`}
        >
          {note.text}
        </span>
      ) : null}
    </>
  );
  const style = indent > 0 ? { paddingLeft: 8 + indent * 14 } : undefined;
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      style={style}
      className={`flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2 ${
        active ? "nav-selected-blue" : ""
      }`}
    >
      {body}
    </button>
  ) : (
    <div className="flex w-full items-center gap-1.5 px-2 py-1.5" style={style}>
      {body}
    </div>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
/** Pick a file-row icon from the extension (images get the image glyph; everything else a doc). */
function fileIcon(name: string): ReactNode {
  return IMAGE_EXT.test(name) ? (
    <ImageIcon size={12} />
  ) : (
    <FileText size={12} />
  );
}

function fileBaseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

interface FileTreeNode {
  folders: Map<string, FileTreeNode>;
  files: ContextFile[];
}

/** Groups a flat list of (possibly slash-nested) `ContextFile.name` paths into a folder tree. */
function buildFileTree(files: ContextFile[]): FileTreeNode {
  const root: FileTreeNode = { folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.name.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let next = node.folders.get(seg);
      if (!next) {
        next = { folders: new Map(), files: [] };
        node.folders.set(seg, next);
      }
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

/** Every folder path in a tree, at any depth — used to seed a group's initial "all collapsed" state. */
function allFolderPaths(node: FileTreeNode, path = ""): Set<string> {
  const paths = new Set<string>();
  for (const [folderName, child] of node.folders) {
    const folderPath = path ? `${path}/${folderName}` : folderName;
    paths.add(folderPath);
    for (const p of allFolderPaths(child, folderPath)) paths.add(p);
  }
  return paths;
}

/** Renders a `FileTreeNode` as folder rows then file rows, each level sorted folder (a-z) then files (a-z). */
function renderFileTree({
  node,
  path,
  depth,
  prefix,
  generated,
  detailNode,
  onSelectNode,
  collapsed,
  toggleFolder,
}: {
  node: FileTreeNode;
  path: string;
  depth: number;
  prefix: "spec" | "artifact" | "gen";
  generated?: boolean;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  collapsed: Set<string>;
  toggleFolder: (path: string) => void;
}): ReactNode[] {
  const rows: ReactNode[] = [];
  const folderNames = [...node.folders.keys()].sort((a, b) =>
    a.localeCompare(b),
  );
  for (const folderName of folderNames) {
    const folderPath = path ? `${path}/${folderName}` : folderName;
    const isOpen = !collapsed.has(folderPath);
    rows.push(
      <FolderRow
        key={`folder:${folderPath}`}
        name={folderName}
        indent={depth}
        open={isOpen}
        onClick={() => toggleFolder(folderPath)}
      />,
    );
    if (isOpen) {
      const childRows = renderFileTree({
        node: node.folders.get(folderName)!,
        path: folderPath,
        depth: depth + 1,
        prefix,
        generated,
        detailNode,
        onSelectNode,
        collapsed,
        toggleFolder,
      });
      rows.push(
        <div key={`children:${folderPath}`} className="relative">
          {/* Indent guide — a vertical line under this folder's icon, spanning its expanded contents, so
              nested files/folders are easy to trace back to the folder they belong to. */}
          <div
            className="absolute bottom-0 top-0 w-px"
            style={{ left: 14 + depth * 14, background: "var(--border)" }}
          />
          {childRows}
        </div>,
      );
    }
  }
  const sortedFiles = [...node.files].sort((a, b) =>
    fileBaseName(a.name).localeCompare(fileBaseName(b.name)),
  );
  for (const f of sortedFiles) {
    rows.push(
      <FileRow
        key={f.name}
        icon={
          generated ? (
            <Lock
              size={12}
              className="shrink-0"
              style={{ color: "var(--slate)" }}
            />
          ) : (
            fileIcon(f.name)
          )
        }
        name={fileBaseName(f.name)}
        indent={depth}
        active={detailNode === `${prefix}:${f.name}`}
        onClick={() => onSelectNode(`${prefix}:${f.name}`)}
        note={{ text: formatBytes(f.size) }}
      />,
    );
  }
  return rows;
}

/** A muted "loading" placeholder row for a region whose files are still being fetched. */
function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span
        className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full"
        style={{ background: "var(--border-2)" }}
      />
      <span className="flex-1 font-mono text-[10.5px] text-faint">{label}</span>
    </div>
  );
}
