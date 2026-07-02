'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Pause,
  Pencil,
  RotateCw,
  Server,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import { Dot, KindBadge, StatusPie } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/cn';
import { pipelineJob } from '@/lib/api/job-api';
import { useRetryJob, useServices } from '@/lib/api/job-queries';
import { Divider, PipelineTree, PrReviewFooter, TasksBody, haltThreadIdx } from './pipeline-tree';
import { NavigatorApproveButton } from './spec-approval';
import { codexReviewNode } from './codex-review';
import { pipelineMainTasks } from '@/lib/api/types';
import { useLiveTurn } from '@/lib/api/job-stream';
import { overlayLiveTasks } from './live-tasks';
import type { CodexReviewSummary, ContextFile, PipelineJob, PipelineState, JobContext, JobKind, JobStatus, TaskItem } from '@/lib/api/types';
import type { JobRef } from '@/lib/api/job-api';

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
  onConversation,
  onSelectNode,
  onRename,
  onDelete,
  deleting,
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
  /** Clears the detail-pane selection (the Main lane / the state banners' recovery actions). */
  onConversation: () => void;
  onSelectNode: (node: string) => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const job = pipelineJob(pipeline);
  const branch = job?.featureBranch ?? job?.baseBranch ?? undefined;
  const hasPr = Boolean(job?.prUrl);
  // We can't read a real +/− line stat (no diff endpoint), but a job that hasn't built anything yet
  // (planning / awaiting / triaging) plainly has no changes — show a muted "—" on the Changes row then.
  const noChanges =
    !hasPr &&
    meta.status !== 'done' &&
    meta.status !== 'running' &&
    meta.status !== 'paused' &&
    meta.status !== 'failed';
  const [editing, setEditing] = useState(false);

  const st = meta.status;

  return (
    <div
      className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border"
      style={{ background: 'color-mix(in srgb, var(--panel) 35%, transparent)' }}
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
              if (e.key === 'Enter') {
                const v = e.currentTarget.value.trim();
                if (v && v !== meta.title) onRename(v);
                setEditing(false);
              } else if (e.key === 'Escape') {
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
          <span className="h-[7px] w-[7px] shrink-0 rounded-sm" style={{ background: meta.orgColor }} />
          <span className="font-mono text-[9.5px] text-dim">{meta.orgName}</span>
          <span className="text-[9px] text-border-2">/</span>
          <span className="font-mono text-[9.5px] font-semibold">{meta.repoName}</span>
        </div>
        {branch ? (
          <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
            <GitBranch size={10} className="shrink-0 text-faint" />
            <span className="flex-1 truncate font-mono text-[9.5px] text-dim">{branch}</span>
            {meta.tracker ? <span className="shrink-0 font-mono text-[9px] text-blue">{meta.tracker} ↗</span> : null}
          </div>
        ) : meta.tracker ? (
          <div className="mt-1.5 font-mono text-[9.5px] text-blue">{meta.tracker} ↗</div>
        ) : null}
        {/* PR — links out once opened, muted resting state until then. */}
        <div className="mt-1 flex items-center gap-1.5 px-1">
          {hasPr ? (
            <a
              href={job!.prUrl!}
              target="_blank"
              rel="noreferrer"
              className="flex flex-1 items-center gap-1.5 rounded py-0.5 hover:bg-surface-2"
            >
              <GitPullRequest size={11} className="shrink-0 text-green" />
              <span className="flex-1 font-mono text-[9.5px] font-semibold text-green">
                {job!.prNumber != null ? `PR #${job!.prNumber}` : 'pull request'} · open
              </span>
              <ArrowUpRight size={11} className="text-faint" />
            </a>
          ) : (
            <div className="flex flex-1 items-center gap-1.5 py-0.5">
              <GitPullRequest size={11} className="shrink-0 text-faint" />
              <span className="flex-1 font-mono text-[9.5px] text-faint">No PR yet</span>
            </div>
          )}
        </div>
        {/* Changes — always available; opens the accumulated diff in the detail pane. */}
        <button
          type="button"
          onClick={() => onSelectNode('diff')}
          className={cn(
            '-mx-4 mt-1 flex w-[calc(100%+2rem)] items-center gap-2.5 px-4 py-1.5 text-left transition hover:bg-surface-2',
            detailNode === 'diff' && 'nav-selected-blue',
          )}
        >
          <span className="w-3.5 shrink-0 text-center font-mono text-[13px] font-bold text-blue">±</span>
          <span className="flex-1 text-[11px] font-semibold text-dim">Changes</span>
          {noChanges ? <span className="font-mono text-[9px] text-faint">—</span> : null}
        </button>
        {/* Approve — pinned as the last header item while the plan is awaiting approval. */}
        {st === 'awaiting_approval' && approveValue ? (
          <div className="mt-2">
            <NavigatorApproveButton jobRef={jobRef} value={approveValue} />
          </div>
        ) : null}
      </div>

      {/* ── scroll body — the constant skeleton (THREADS · OUTPUTS · PORTS). No horizontal padding: rows
             carry their own px, so each is a full-width band (design "Atlas Workspace HiFi") and the
             selected `.nav-selected` band + left accent bar can run flush to the rail edge. ─────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto py-3">
        <StateBanner status={st} job={job} jobRef={jobRef} onConversation={onConversation} />

        {/* THREADS — the Main planning lane + each build lane, as an ACCORDION (design handoff "thread
            navigation"): selecting a thread opens its fold (state rail + wash + tasks/review agents) and
            collapses whichever was open. Selecting opens it in the LEFT pane. */}
        <MainLaneRow
          active={laneNode === null}
          running={st === 'running' || st === 'planning'}
          jobId={jobRef.jobId}
          durableTasks={pipelineMainTasks(pipeline)}
          onClick={onConversation}
        />
        {/* Codex review — a lane directly under Main, shown once the plan has been submitted for review.
            Opens the full round-by-round review dialogue in the detail pane (blue-highlighted, like a node). */}
        {job?.codexReview ? (
          <CodexReviewRow
            review={job.codexReview}
            active={laneNode === codexReviewNode(jobRef.jobId)}
            onOpen={() => onSelectNode(codexReviewNode(jobRef.jobId))}
          />
        ) : null}
        <ThreadRows
          status={st}
          job={job}
          jobId={jobRef.jobId}
          laneNode={laneNode}
          detailNode={detailNode}
          onSelectNode={onSelectNode}
          onConversation={onConversation}
        />

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
        <ServicesRegion jobRef={jobRef} detailNode={detailNode} onSelectNode={onSelectNode} />

        {/* PORTS — the sandbox's live dev servers (design-stage mock). Open in the RIGHT pane (blue). */}
        <PortsRegion detailNode={detailNode} onSelectNode={onSelectNode} />
      </div>

      {/* PINNED: the FINAL REVIEW footer — the single job-level master-review thread (PR Review), pinned
          below the scrolling regions. Hidden entirely while no plan exists (no threads yet). */}
      {job && job.threads.length > 0 ? (
        <PrReviewFooter
          job={job}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
          onConversation={onConversation}
        />
      ) : null}
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
  const done = tasks.filter((t) => t.status === 'completed').length;
  return (
    <div
      className="border-l-[3px]"
      style={
        active
          ? { borderLeftColor: 'var(--green)', background: 'color-mix(in srgb, var(--green) 6%, transparent)' }
          : { borderLeftColor: 'transparent', background: 'transparent' }
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
        <span className={cn('flex-1 truncate text-[12px]', active ? 'font-semibold text-text' : 'font-medium text-dim')}>
          Main
        </span>
        <span className="shrink-0 font-mono text-[8px] text-faint">
          {tasks.length > 0 ? `[${done}/${tasks.length}]` : 'planning'}
        </span>
      </button>
      {active && tasks.length > 0 ? <TasksBody tasks={tasks} done={done} total={tasks.length} /> : null}
    </div>
  );
}

/** The Codex review lane — a lane like Main/build threads (LEFT pane), opening the full plan-review dialogue
 *  in the same transcript renderer. Highlighted ORANGE (`nav-selected`), pulses while a round is running. */
function CodexReviewRow({
  review,
  active,
  onOpen,
}: {
  review: CodexReviewSummary;
  active: boolean;
  onOpen: () => void;
}) {
  const running = review.status === 'running';
  const note = running
    ? 'reviewing'
    : review.status === 'failed'
      ? 'error'
      : review.findingsCount === 0
        ? 'clean'
        : `${review.findingsCount} finding${review.findingsCount === 1 ? '' : 's'}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2',
        active && 'nav-selected',
      )}
    >
      <Dot color="var(--slate)" pulse={running} size={9} />
      <span className="flex-1 truncate text-[12px] font-semibold text-text">Codex review</span>
      {review.rounds > 1 ? (
        <span className="font-mono text-[8px] text-faint">·{review.rounds}</span>
      ) : null}
      <span className="font-mono text-[8px] text-faint">{note}</span>
    </button>
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
  detailNode,
  onSelectNode,
  onConversation,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  jobId: string;
  laneNode: string | null;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  onConversation: () => void;
}) {
  // Triaging — the autonomous lane: triage findings, not a build tree.
  if (status === 'triaging') {
    return (
      <>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--green)' }} />
          <span className="flex-1 text-[11.5px] text-dim">Verified &amp; classified</span>
        </div>
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="pulse-dot h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--slate)' }} />
          <span className="flex-1 text-[11.5px] text-text">1 decision parked for you</span>
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
      detailNode={detailNode}
      onSelectNode={onSelectNode}
      onConversation={onConversation}
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
  const triaging = status === 'triaging';

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
            Waiting for <span className="font-mono text-[10px] text-dim">plan.md</span>
          </>
        }
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      >
        {triaging ? (
          <div
            className="mx-1.5 mb-1 rounded-md border border-l-2 px-3 py-2.5"
            style={{ borderColor: 'var(--border)', borderLeftColor: 'var(--slate)', background: 'var(--surface-2)' }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <GitPullRequest size={11} className="text-dim" />
              <span className="flex-1 font-mono text-[10px] font-semibold">github · workflow_run</span>
              <span
                className="rounded border px-1.5 py-px font-mono text-[8px] font-semibold"
                style={{ color: 'var(--slate)', background: 'var(--slate-soft)', borderColor: 'var(--slate-line)' }}
              >
                UNTRUSTED
              </span>
            </div>
            <p className="text-[10.5px] leading-snug text-dim">An untrusted notification seeded this job.</p>
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
  prefix: 'spec' | 'artifact' | 'gen';
  generated?: boolean;
  loading?: boolean;
  emptyIcon: ReactNode;
  emptyText: ReactNode;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <Divider label={label} count={files.length > 0 ? files.length : <ZeroCount />} />
      {children}
      {files.length > 0 ? (
        files.map((f) => (
          <FileRow
            key={f.name}
            icon={generated ? <Lock size={12} className="shrink-0" style={{ color: 'var(--slate)' }} /> : fileIcon(f.name)}
            name={f.name}
            active={detailNode === `${prefix}:${f.name}`}
            onClick={() => onSelectNode(`${prefix}:${f.name}`)}
            note={{ text: formatBytes(f.size) }}
          />
        ))
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
      <Divider label="SERVICES" count={services.length > 0 ? services.length : <ZeroCount />} />
      {services.length > 0 ? (
        services.map((s) => {
          const node = `service:${s.id}`;
          const active = detailNode === node;
          const recentlyActive = s.logUpdatedAt != null && Date.now() - Date.parse(s.logUpdatedAt) < 15_000;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectNode(node)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition hover:bg-surface-2',
                active && 'nav-selected-blue',
              )}
            >
              <Dot color="var(--accent)" pulse={recentlyActive} size={9} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-text">{s.name}</span>
                <span className="block truncate font-mono text-[8px] text-faint">{s.cmd || 'atlas-svc'}</span>
              </span>
            </button>
          );
        })
      ) : isLoading ? (
        <LoadingRow label="Loading…" />
      ) : (
        <EmptyRow icon={<SquareTerminal size={13} />}>No services running yet</EmptyRow>
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
  tag: 'W' | 'S';
  name: string;
  meta: string;
}

const MOCK_PORTS: PortVM[] = [
  { id: 'billing', tag: 'W', name: 'Billing UI', meta: ':3000 · web app' },
  { id: 'admin', tag: 'W', name: 'Admin', meta: ':3002 · web app' },
  { id: 'api', tag: 'S', name: 'API server', meta: ':8080 · server' },
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
              <span className="pulse-dot h-[5px] w-[5px] rounded-full" style={{ background: 'var(--green)' }} />
              {ports.length} live
            </span>
          ) : (
            <ZeroCount />
          )
        }
      />
      {ports.length === 0 ? <EmptyRow icon={<Globe size={13} />}>No ports exposed yet</EmptyRow> : null}
      {ports.map((p) => {
        const node = `port:${p.id}`;
        const active = detailNode === node;
        const web = p.tag === 'W';
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectNode(node)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition hover:bg-surface-2',
              active && 'nav-selected-blue',
            )}
          >
            <span
              className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px]"
              style={{
                color: web ? 'var(--blue)' : 'var(--green)',
                background: web ? 'color-mix(in srgb, var(--blue) 13%, transparent)' : 'var(--green-soft)',
              }}
            >
              {web ? <Globe size={11} /> : <Server size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-semibold text-text">{p.name}</span>
              <span className="block truncate font-mono text-[8px] text-faint">{p.meta}</span>
            </span>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--green)', boxShadow: '0 0 0 3px color-mix(in srgb, var(--green) 16%, transparent)' }}
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
  if (status === 'failed') {
    const haltNo = job ? haltSectionNo(job) : null;
    return (
      <div
        className="mx-1.5 my-1 rounded-md border px-3 py-2.5"
        style={{ borderColor: 'var(--red-line)', background: 'var(--red-soft)' }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <AlertTriangle size={11} className="text-red" />
          <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-red">
            HALTED{haltNo ? ` · §${haltNo}` : ''}
          </span>
        </div>
        <p className="text-[10.5px] leading-snug text-dim">
          The run stopped — read the conversation for the halt, then steer or retry.
        </p>
        <div className="mt-2 flex gap-1.5">
          <BannerBtn
            tone="red"
            icon={<RotateCw size={10} />}
            label={retry.isPending ? 'Retrying…' : 'Retry'}
            onClick={onRetry}
            disabled={retry.isPending}
          />
          <BannerBtn tone="neutral" label="Revert" onClick={onConversation} />
        </div>
      </div>
    );
  }
  if (status === 'paused') {
    return (
      <div
        className="mx-1.5 my-1 rounded-md border border-l-2 px-3 py-2.5"
        style={{ borderColor: 'var(--border)', borderLeftColor: 'var(--faint)', background: 'var(--surface-2)' }}
      >
        <div className="mb-1 flex items-center gap-1.5">
          <Pause size={11} className="text-dim" />
          <span className="font-mono text-[9px] font-semibold tracking-[0.04em] text-dim">SESSION SAVED</span>
        </div>
        <p className="text-[10.5px] leading-snug text-dim">
          The live session is held — reply to resume the same session.
        </p>
        <div className="mt-2 flex gap-1.5">
          <BannerBtn
            tone="accent"
            icon={<RotateCw size={10} />}
            label={retry.isPending ? 'Resuming…' : 'Re-ping'}
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
  tone: 'red' | 'accent' | 'neutral';
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const style =
    tone === 'red'
      ? { color: 'var(--red)', background: 'var(--red-soft)', borderColor: 'var(--red-line)' }
      : tone === 'accent'
        ? { color: 'var(--accent)', background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
        : { color: 'var(--dim)', background: 'transparent', borderColor: 'var(--border-2)' };
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
function EmptyRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-2 flex items-center gap-2 rounded-[9px] border border-dashed border-border-2 px-2.5 py-[7px]">
      <span className="shrink-0 text-faint">{icon}</span>
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted">{children}</span>
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
        style={{ background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)' }}
      >
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-dashed border-border-2" />
        <span className="h-2 flex-1 rounded bg-surface-3" />
        <span className="h-2 w-6 shrink-0 rounded bg-surface-3" />
      </div>
      <p className="px-1 text-[11px] leading-relaxed text-dim">
        No build lanes yet — approve the plan and Atlas splits the work into lanes here.
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
}: {
  icon: ReactNode;
  name: string;
  dim?: boolean;
  active?: boolean;
  onClick?: () => void;
  note?: { text: string; pulse?: boolean };
}) {
  const body = (
    <>
      <span className="shrink-0">{icon}</span>
      <span className={`flex-1 truncate font-mono text-[11px] ${dim ? 'text-dim' : ''}`}>{name}</span>
      {note ? (
        <span className={`font-mono text-[8px] ${note.pulse ? 'pulse-dot text-accent' : 'text-faint'}`}>{note.text}</span>
      ) : null}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2 ${
        active ? 'nav-selected-blue' : ''
      }`}
    >
      {body}
    </button>
  ) : (
    <div className="flex items-center gap-2.5 px-2 py-1.5">{body}</div>
  );
}

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
/** Pick a file-row icon from the extension (images get the image glyph; everything else a doc). */
function fileIcon(name: string): ReactNode {
  return IMAGE_EXT.test(name) ? <ImageIcon size={12} /> : <FileText size={12} />;
}

/** A muted "loading" placeholder row for a region whose files are still being fetched. */
function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <span className="h-[7px] w-[7px] shrink-0 animate-pulse rounded-full" style={{ background: 'var(--border-2)' }} />
      <span className="flex-1 font-mono text-[10.5px] text-faint">{label}</span>
    </div>
  );
}

/** Kebab → "Rename job" + a two-click "Delete job" (real `PATCH` / `DELETE …/threads/:id`). */
function JobMenu({
  onStartRename,
  onDelete,
  deleting,
}: {
  onStartRename?: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirm(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-faint transition hover:bg-surface-2 hover:text-text"
        aria-label="Job actions"
      >
        <MoreHorizontal size={15} />
      </button>
      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+4px)] z-50 w-44 overflow-hidden rounded-md border border-border bg-panel py-1"
          style={{ boxShadow: 'var(--shadow-menu)' }}
        >
          {onStartRename ? (
            <button
              type="button"
              onClick={() => {
                onStartRename();
                setOpen(false);
                setConfirm(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-text transition hover:bg-surface-2"
            >
              <Pencil size={13} className="text-dim" />
              Rename job
            </button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                if (confirm) {
                  // Keep the menu open so the button's "Deleting…" state is visible while the request is
                  // in flight (don't close it out from under the user — that was the "frozen, no feedback"
                  // window). The menu unmounts on the post-success navigation anyway.
                  onDelete();
                  setConfirm(false);
                } else {
                  setConfirm(true);
                }
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red transition hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)] disabled:opacity-50"
            >
              <Trash2 size={13} />
              {deleting ? 'Deleting…' : confirm ? 'Click again to confirm' : 'Delete job'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
