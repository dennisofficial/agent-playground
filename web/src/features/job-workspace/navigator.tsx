"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  ChevronRight,
  CornerUpLeft,
  FileText,
  Folder,
  GitBranch,
  GitFork,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
  Hourglass,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Pause,
  Pencil,
  RotateCw,
  Server,
  ShieldCheck,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  CiHeaderGlyph,
  Dot,
  KindBadge,
  StatusPie,
} from "@/components/ui/badges";
import { STATUS_META } from "@/lib/api/status";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";
import { pipelineJob, resolveJob, ThreadApiError } from "@/lib/api/job-api";
import {
  useAcceptThread,
  useJobCreatedJobs,
  useRetryJob,
  useRetryVerification,
  useServices,
} from "@/lib/api/job-queries";
import { threadHref } from "@/lib/routes";
import {
  Divider,
  PipelineTree,
  TasksBody,
  haltThreadIdx,
} from "./pipeline-tree";
import { codexReviewNode } from "./codex-review";
import { NavigatorApproveButton, NavigatorShipButton } from "./spec-approval";
import { pipelineAutoApproveMode, pipelineMainTasks } from "@/lib/api/types";
import type { AutoApproveMode } from "@workspace/shared";
import { autoPillView } from "./auto-approve-mode";
import { AutoApprovePopover } from "./auto-approve-popover";
import { useLiveTurn } from "@/lib/api/job-stream";
import { overlayLiveTasks } from "./live-tasks";
import type {
  ContextFile,
  JobBlocker,
  JobProvenance,
  PipelineJob,
  PipelineState,
  JobContext,
  JobKind,
  JobStatus,
  ServiceInfo,
  TaskItem,
} from "@/lib/api/types";
import type { JobRef } from "@/lib/api/job-api";
import { PlanReviewRow } from "@/features/job-workspace/plan-review-row";
import { JobMenu } from "@/features/job-workspace/job-menu";
import { FolderRow } from "@/features/job-workspace/folder-row";
import { EphemeralToast, useEphemeralToast } from "./ephemeral-toast";

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

const AUTO_APPROVE_TITLES: Record<AutoApproveMode, string> = {
  off: "Auto-approve off — you approve plan & ship gates",
  both: "Auto-approve on — plan & ship gates advance without you",
  plan: "Auto-approve: plan gate only",
  ship: "Auto-approve: ship gate only",
};

/** Compact header pill for the per-job AUTO-APPROVE mode. Opens a popover with independent Plan/Ship
 *  switches; the pill's color + label reflect the resulting mode (quiet grey off, amber naming the single
 *  active gate, solid green "Auto" once both gates are armed). Disabled on terminal jobs. */
function AutoApproveToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: AutoApproveMode;
  disabled?: boolean;
  onChange: (mode: AutoApproveMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [draftMode, setDraftMode] = useState(mode);
  const btnRef = useRef<HTMLButtonElement>(null);
  const view = autoPillView(draftMode);

  useEffect(() => {
    setDraftMode(mode);
  }, [mode]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={AUTO_APPROVE_TITLES[draftMode]}
        title={AUTO_APPROVE_TITLES[draftMode]}
        disabled={disabled}
        onClick={() => {
          setAnchorRect(btnRef.current?.getBoundingClientRect() ?? null);
          setOpen((o) => !o);
        }}
        data-testid="auto-approve-toggle"
        className={cn(
          "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.05em] transition",
          disabled && "cursor-not-allowed opacity-40",
          view.tone === "full" && "border-green bg-green-soft text-green",
          view.tone === "partial" && "border-amber bg-amber-soft text-amber",
          view.tone === "off" &&
            "border-border-2 bg-surface text-faint hover:text-dim",
        )}
      >
        <ShieldCheck className="h-3 w-3" strokeWidth={2.25} />
        {view.label}
      </button>
      {open && anchorRect ? (
        <AutoApprovePopover
          anchorRect={anchorRect}
          triggerRef={btnRef}
          mode={draftMode}
          onSelect={(next) => {
            setDraftMode(next);
            onChange(next);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
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
  /** The job that spawned this one (immutable snapshot), or null for a top-level job — powers the
   *  "Created by" header row. */
  createdBy?: JobProvenance | null;
  /** This job's live blockers — powers the "Blocked by" header row + detail pane. `[]` unless the job is
   *  actually `blocked` (or was and hasn't refreshed yet). */
  blockedBy?: JobBlocker[];
  /** The pending seed message a born-blocked job will start on when it unblocks — powers the blocked
   *  overlay's pending-message preview. null unless the job is `blocked` with a seed. */
  blockedSeedMessage?: string | null;
}

/**
 * The 288px JOB navigator (design "Atlas Workspace HiFi") — ONE constant skeleton for the job's whole
 * lifecycle: a STICKY header (kind · status · title · org/repo · branch · PR · changes) over three scrolling
 * regions — THREADS (the Main planning lane + each build lane), OUTPUTS (specs / artifacts / generated), and
 * PORTS (the sandbox's live dev servers). The header stays pinned; only the regions scroll. The skeleton
 * never restructures; only the signals inside change (dot color, dimming, the selected row, per-region notes).
 *
 * "Job" is the operator-facing name for what the API still calls a thread; a job's lanes ("Threads") are the
 * Main conversation + the build threads. PORTS is a filtered live view of the sandbox's supervised services
 * (those that declared a port), each exposed row linking out to its public preview URL.
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
  previewRequestedAt,
  onConversation,
  onSelectNode,
  onRename,
  onDelete,
  onSetAutoApprove,
  deleting,
  hasOpenPr,
  deleteReady,
  directBuild,
  inDrawer = false,
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
  /** The ship card's `previewRequestedAt` — gates the header "Spin up preview" button (hidden once a
   *  preview has been requested). */
  previewRequestedAt?: string | null;
  /** Clears the detail-pane selection (the Main lane / the state banners' recovery actions). */
  onConversation: () => void;
  onSelectNode: (node: string) => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  /** Set the per-job auto-approve mode — the header pill's popover. Absent ⇒ the pill isn't rendered. */
  onSetAutoApprove?: (mode: AutoApproveMode) => void;
  deleting?: boolean;
  /** True when the job's PR is open — routes delete through the secondary PR-choice dialog instead of the
   *  inline double-click confirm. */
  hasOpenPr?: boolean;
  /** True once the PR state is known (resolved from either the pipeline or the inbox feed) — the delete
   *  button stays disabled until then so we never delete before knowing whether a PR is open. */
  deleteReady?: boolean;
  /** True when the awaiting approval is a direct build — flips the approve CTA to "Approve Direct Build". */
  directBuild?: boolean;
  /** Rendered inside the left Drawer (below xl) — fills the sheet width instead of the fixed 288px rail. */
  inDrawer?: boolean;
}) {
  const job = pipelineJob(pipeline);
  // A COMMITTED direct build (durable `jobs.build_path`, stamped only at approval) never grows build lanes,
  // a `plan.md`, or generated plan docs — so its plan-oriented empty-state placeholders are pure noise.
  // Gates on the persisted field, NOT the `directBuild` approval-CTA hint (which is derived from message
  // history and only meaningful at the approval gate). Null while still awaiting approval ⇒ false ⇒ a
  // requested-but-unapproved direct build keeps its placeholders (it can still convert to a full plan).
  const isDirectBuild = job?.buildPath === "direct";
  // AUTO-APPROVE mode — read from the RAW pipeline (not `job`), so it works for an open/pre-plan job whose
  // pipeline is the `no_job` shape (`pipelineJob()` is null there but the mode still rides along).
  const autoApproveMode = pipelineAutoApproveMode(pipeline);
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
    meta.status !== "amending";
  const [editing, setEditing] = useState(false);

  // Jobs Atlas spawned FROM this job — the header "Created jobs" entry appears only once there's ≥1.
  const { data: createdJobs = [] } = useJobCreatedJobs(jobRef);

  // Supervised services drive BOTH the SERVICES and PORTS regions — fetched once here and passed down so
  // the two regions share a single poll (PORTS is a filtered view of the same services).
  const { data: servicesData, isLoading: servicesLoading } =
    useServices(jobRef);
  const services = servicesData?.services ?? [];

  const st = meta.status;
  const router = useRouter();
  const { toast, show: showToast } = useEphemeralToast();

  // Resolve-then-navigate — a "Created by" / "Blocked by" link points at a job that could have been hard-
  // deleted since the snapshot was taken, so we confirm it still exists before routing there; a 404 toasts
  // instead of opening a dead workspace.
  const openJob = async (targetJobId: string) => {
    try {
      await resolveJob({ ...jobRef, jobId: targetJobId });
      router.push(
        threadHref({
          orgId: jobRef.orgId,
          repoId: jobRef.repoId,
          jobId: targetJobId,
        }),
      );
    } catch (err) {
      if (err instanceof ThreadApiError && err.status === 404) {
        showToast("This job was deleted.");
      } else {
        console.error("Failed to resolve job", err);
      }
    }
  };

  return (
    <div
      data-testid="job-navigator"
      className={cn(
        "flex flex-col overflow-hidden border-r border-border",
        inDrawer ? "h-full w-full" : "w-72 shrink-0",
      )}
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
          {onSetAutoApprove ? (
            <AutoApproveToggle
              mode={autoApproveMode}
              disabled={
                st === "done" || st === "cancelled" || st === "deleting"
              }
              onChange={onSetAutoApprove}
            />
          ) : null}
          {onDelete || onRename ? (
            <JobMenu
              onStartRename={onRename ? () => setEditing(true) : undefined}
              onDelete={onDelete}
              deleting={deleting}
              hasOpenPr={hasOpenPr}
              deleteReady={deleteReady}
              jobRef={jobRef}
              status={st}
              blockedBy={meta.blockedBy ?? []}
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
        {/* Created by — the job that spawned this one (immutable snapshot). Resolve-then-navigate: a
            deleted parent 404s and toasts instead of opening a dead workspace. */}
        {meta.createdBy ? (
          <button
            type="button"
            onClick={() => openJob(meta.createdBy!.jobId)}
            className="-mx-4 mt-1.5 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2"
          >
            <CornerUpLeft size={13} className="w-3.5 shrink-0 text-accent" />
            <span className="flex-1 truncate text-[11px] font-semibold text-dim">
              Created by {meta.createdBy.title || "a job"}
            </span>
          </button>
        ) : null}
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
              const showCi = job!.prNumber != null;
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
                  {showCi ? (
                    <CiHeaderGlyph ci={job!.ciStatus} counts={job!.ciCounts} />
                  ) : null}
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
                  {showCi ? (
                    <CiHeaderGlyph ci={job!.ciStatus} counts={job!.ciCounts} />
                  ) : null}
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
        {/* Created jobs — appears only once this job has spawned ≥1 follow-up job; opens the standing
            "Created jobs" list in the detail pane. */}
        {createdJobs.length > 0 ? (
          <button
            type="button"
            onClick={() => onSelectNode("created")}
            className={cn(
              "-mx-4 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2",
              detailNode === "created" && "nav-selected-blue",
            )}
          >
            <GitFork size={13} className="w-3.5 shrink-0 text-accent" />
            <span className="flex-1 text-[11px] font-semibold text-dim">
              Created jobs
            </span>
            <span className="font-mono text-[9px] text-faint">
              {createdJobs.length}
            </span>
          </button>
        ) : null}
        {/* Blocked by — a REAL gate (the brain doesn't run while it's up); appears whenever the job is
            parked or still carries live blockers. */}
        {st === "blocked" || (meta.blockedBy?.length ?? 0) > 0 ? (
          <button
            type="button"
            onClick={() => onSelectNode("blocked-by")}
            className={cn(
              "-mx-4 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2",
              detailNode === "blocked-by" && "nav-selected-blue",
            )}
          >
            <Lock
              size={13}
              className="w-3.5 shrink-0"
              style={{ color: "var(--amber)" }}
            />
            <span className="flex-1 text-[11px] font-semibold text-dim">
              Blocked by
            </span>
            <span className="font-mono text-[9px] text-faint">
              {meta.blockedBy?.length ?? 0}
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
            <NavigatorShipButton
              jobRef={jobRef}
              value={shipValue}
              previewRequestedAt={previewRequestedAt}
            />
          </div>
        ) : null}
      </div>

      {/* ── scroll body — the constant skeleton (THREADS · OUTPUTS · PORTS). No horizontal padding: rows
             carry their own px, so each is a full-width band (design "Atlas Workspace HiFi") and the
             selected `.nav-selected` band + left accent bar can run flush to the rail edge. ─────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto py-3">
        <StateBanner
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
          isDirectBuild={isDirectBuild}
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
          isDirectBuild={isDirectBuild}
        />

        {/* SERVICES — real atlas-svc supervised processes (dev servers Atlas brought up on demand). Open in
            the RIGHT pane (blue), which streams the process's captured log. */}
        <ServicesRegion
          services={services}
          isLoading={servicesLoading}
          detailNode={detailNode}
          onSelectNode={onSelectNode}
        />

        {/* PORTS — the sandbox's live dev servers (real exposures). Rows link out to the public URL. Shares
            the SERVICES poll (same `useServices` query) rather than fetching a second time. */}
        <PortsRegion services={services} />
      </div>
      <EphemeralToast message={toast} />
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
  isDirectBuild,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  jobId: string;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
  /** A committed direct build has no lanes by design — suppress the "approve the plan" empty state. */
  isDirectBuild?: boolean;
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
  // drafts render as bare thread rows (dashed dots, no tasks). Empty (early planning) → the hero ghost row —
  // EXCEPT a committed direct build, which never grows lanes, so its "approve the plan" ghost is just noise.
  // PLAN VERSIONING: prior revisions (browsable history) render below the active lanes; a re-propose/direct
  // build over already-DONE work can leave the active lanes empty while history persists — show history then.
  const prior = job?.priorRevisions ?? [];
  if (!job || (job.threads.length === 0 && prior.length === 0)) {
    return isDirectBuild ? null : <BuildLanesEmpty />;
  }
  return (
    <>
      {job.threads.length > 0 ? (
        <PipelineTree
          job={job}
          status={status}
          jobId={jobId}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />
      ) : null}
      {prior.map((rev) => (
        <PriorRevisionSection
          key={rev.decisionRecordId}
          job={job}
          revision={rev}
          jobId={jobId}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />
      ))}
    </>
  );
}

/**
 * One PRIOR PLAN REVISION as a collapsed, muted "Previous plan (vN)" section — read-only history from an
 * earlier plan that was superseded by a re-propose over already-DONE work. Reuses `PipelineTree` with a
 * synthetic job (the revision's lanes, no active halt); the muted wrapper reads as history while lane clicks
 * still open each lane's persisted transcript (browsing is the point). Collapsed by default to stay quiet.
 */
function PriorRevisionSection({
  job,
  revision,
  jobId,
  laneNode,
  onSelectNode,
}: {
  job: PipelineJob;
  revision: NonNullable<PipelineJob["priorRevisions"]>[number];
  jobId: string;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const revJob: PipelineJob = { ...job, threads: revision.threads, halt: null };
  return (
    <details className="mt-1 opacity-70">
      <summary className="cursor-pointer list-none px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-dim">
        Previous plan (v{revision.revision})
      </summary>
      <div className="mt-0.5">
        <PipelineTree
          job={revJob}
          status="done"
          jobId={jobId}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />
      </div>
    </details>
  );
}

// ── OUTPUTS: specs / artifacts / generated, merged into one region ─────────────────────────────────

function OutputsRegion({
  status,
  context,
  loading,
  detailNode,
  onSelectNode,
  isDirectBuild,
}: {
  status: JobStatus;
  context: JobContext | undefined;
  loading?: boolean;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  /** A committed direct build has no `plan.md` and (usually) no generated plan docs — hide those groups
   *  entirely when empty, instead of showing their plan-oriented ghost rows. */
  isDirectBuild?: boolean;
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
        hideWhenEmpty={isDirectBuild}
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
        hideWhenEmpty={isDirectBuild}
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
  hideWhenEmpty,
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
  /** Drop the whole group (divider + empty row) when it has no files and nothing is loading/pending —
   *  used to hide the plan-oriented SPECS/GENERATED groups for a direct build, where they never populate. */
  hideWhenEmpty?: boolean;
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
  // Drop the group whole (no divider, no ghost row) when asked to hide-when-empty and there's genuinely
  // nothing to show — placed AFTER the hooks above so their order stays unconditional.
  if (hideWhenEmpty && files.length === 0 && !loading && !children) return null;
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
  services,
  isLoading,
  detailNode,
  onSelectNode,
}: {
  services: ServiceInfo[];
  isLoading: boolean;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
}) {
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

// ── PORTS: the sandbox's live dev servers (real exposures) ─────────────────────────────────────────

/** The PORTS region: a filtered view of the same supervised services as SERVICES, showing only those that
 *  declared a port and haven't stopped. Each exposed row (`url` present) links out to its public preview
 *  URL. When exposure is off (backend sends `url: null`), rows still render as a read-only port list. */
function PortsRegion({ services }: { services: ServiceInfo[] }) {
  const ports = services.filter(
    (s) => s.port != null && s.status !== "stopped",
  );
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
      {ports.map((s) => {
        const linked = s.url != null;
        const running = s.status === "running";
        // The whole row is the same band whether it's a link-out or an inert port entry; the anchor form is
        // only used when there's a public URL to open.
        const rowClass = cn(
          "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition",
          linked ? "hover:bg-surface-2" : "cursor-default",
        );
        const inner = (
          <>
            <span
              className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px]"
              style={{
                color: linked ? "var(--blue)" : "var(--faint)",
                background: linked
                  ? "color-mix(in srgb, var(--blue) 13%, transparent)"
                  : "var(--surface-2)",
              }}
            >
              {linked ? <Globe size={11} /> : <Server size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-[11px] font-semibold",
                  running ? "text-text" : "text-faint",
                )}
              >
                {s.name}
              </span>
              <span className="block truncate font-mono text-[8px] text-faint">
                :{s.port}
              </span>
            </span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={
                running
                  ? {
                      background: "var(--green)",
                      boxShadow:
                        "0 0 0 3px color-mix(in srgb, var(--green) 16%, transparent)",
                    }
                  : { background: "var(--faint)" }
              }
            />
          </>
        );
        return linked ? (
          <a
            key={s.id}
            href={s.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className={rowClass}
          >
            {inner}
          </a>
        ) : (
          <div key={s.id} className={rowClass}>
            {inner}
          </div>
        );
      })}
    </>
  );
}

// ── state banners (failed / paused / awaiting) ─────────────────────────────────────────────────────

function StateBanner({
  job,
  jobRef,
  onConversation,
}: {
  job: PipelineJob | null;
  jobRef: JobRef;
  onConversation: () => void;
}) {
  const retry = useRetryJob(jobRef);
  const retryVerification = useRetryVerification(jobRef);
  const acceptThread = useAcceptThread(jobRef);
  // Re-drive the halted build, then drop to the conversation to watch it resume.
  const onRetry = () => {
    retry.mutate(undefined, { onSuccess: onConversation });
  };

  // The judge_unavailable escape hatch takes precedence over the classic job.halt banners: a thread held on
  // a verification-judge outage stays recoverable both during patient auto-retry (job.halt still null) AND
  // after the backstop rest stamps job.halt='incomplete' — the classic Retry can't re-run a blocked lane.
  const stuck = job?.threads?.find(
    (t) => t.condition === "paused" && t.blockReason === "judge_unavailable",
  );
  if (stuck) {
    const pending = retryVerification.isPending || acceptThread.isPending;
    const onRetryNow = () =>
      retryVerification.mutate(stuck.id, { onSuccess: onConversation });
    const onAccept = () =>
      acceptThread.mutate(stuck.id, { onSuccess: onConversation });
    // "Skip & accept" shows only when the LIVE judge was the outage and the static gate already passed (d4);
    // "Retry now" is always safe (it just re-runs the judge), so it shows for any judge_unavailable hold.
    const canAccept = stuck.acceptableOnJudgeOutage === true;
    return (
      <div
        className="mx-1.5 my-1 rounded-md border border-l-2 px-3 py-2.5"
        style={{
          borderColor: "var(--border)",
          borderLeftColor: "var(--accent-line)",
          background: "var(--surface-2)",
        }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <Hourglass size={11} className="text-dim" />
          <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-dim">
            VERIFICATION UNAVAILABLE · §{stuck.ordinal}
          </span>
        </div>
        <p className="text-[10.5px] leading-snug text-dim">
          The verification judge was unreachable. Retry it, or accept the work
          as-is.
        </p>
        <div className="mt-2 flex gap-1.5">
          <BannerBtn
            tone="accent"
            icon={<RotateCw size={10} />}
            label={retryVerification.isPending ? "Retrying…" : "Retry now"}
            onClick={onRetryNow}
            disabled={pending}
          />
          {canAccept && (
            <BannerBtn
              tone="neutral"
              label={acceptThread.isPending ? "Accepting…" : "Skip & accept"}
              onClick={onAccept}
              disabled={pending}
            />
          )}
        </div>
      </div>
    );
  }

  if (
    job?.halt &&
    (job.halt.kind === "failed" ||
      job.halt.kind === "budget_exhausted" ||
      job.halt.kind === "incomplete")
  ) {
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
  if (job?.halt?.kind === "blocked_credentials") {
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
