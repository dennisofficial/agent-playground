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
  Trash2,
} from 'lucide-react';
import { Dot, KindBadge, StatusPie } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/cn';
import { pipelineJob } from '@/lib/api/thread-api';
import { useRetryThread } from '@/lib/api/thread-queries';
import { Divider, PipelineTree, haltThreadIdx } from './pipeline-tree';
import { NavigatorApproveButton } from './spec-approval';
import type { ContextFile, PipelineJob, PipelineState, ThreadContext, JobKind, JobStatus } from '@/lib/api/types';
import type { JobMessage, JobRef } from '@/lib/api/thread-api';

export interface ThreadMeta {
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
 * Main conversation + the build tracks. PORTS is a design-stage mock (no backend port-exposure yet) — kept
 * behind {@link PORTS_MOCK} so it is trivial to wire to real sandbox ports later.
 */
export function Navigator({
  meta,
  pipeline,
  messages,
  context,
  contextLoading,
  laneNode,
  detailNode,
  threadRef,
  approveValue,
  onConversation,
  onSelectNode,
  onRename,
  onDelete,
  deleting,
}: {
  meta: ThreadMeta;
  pipeline: PipelineState | undefined;
  /** The job's durable transcript — the pipeline tree derives each lane-session's writer-subagent runs
   *  from it (the `/pipeline` read model doesn't carry them; see `thread-subagents.ts`). */
  messages: JobMessage[];
  /** The job's `/context` files (specs + generated + artifacts) — feeds the OUTPUTS region. */
  context: ThreadContext | undefined;
  contextLoading?: boolean;
  /** The LEFT pane's open THREADS lane (`?lane=`; `null` = Main) — highlighted ORANGE. */
  laneNode: string | null;
  /** The RIGHT pane's open detail node (`?node=`; OUTPUT / port / doc) — highlighted BLUE. */
  detailNode: string | null;
  /** The open job — for the in-place "Approve plan" callout. */
  threadRef: JobRef;
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
            <ThreadMenu
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
            <NavigatorApproveButton threadRef={threadRef} value={approveValue} />
          </div>
        ) : null}
      </div>

      {/* ── scroll body — the constant skeleton (THREADS · OUTPUTS · PORTS). No horizontal padding: rows
             carry their own px, so each is a full-width band (design "Atlas Workspace HiFi") and the
             selected `.nav-selected` band + left accent bar can run flush to the rail edge. ─────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto py-3">
        <StateBanner status={st} job={job} threadRef={threadRef} onConversation={onConversation} />

        {/* THREADS — the Main planning lane + each build lane. No section header (flat list); selecting one
            opens it in the LEFT pane (orange highlight). */}
        <MainLaneRow
          active={laneNode === null}
          running={st === 'running' || st === 'planning'}
          onClick={onConversation}
        />
        <ThreadsTracks
          status={st}
          job={job}
          messages={messages}
          jobId={threadRef.jobId}
          laneNode={laneNode}
          onSelectNode={onSelectNode}
        />

        {/* OUTPUTS — specs / artifacts / generated, merged. Open in the RIGHT pane (blue highlight). */}
        <OutputsRegion
          status={st}
          context={context}
          loading={contextLoading}
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

/** The Main planning lane — the job's brain conversation. Selecting it clears the detail pane so the
 *  conversation is the focus; active when nothing else is selected. */
function MainLaneRow({ active, running, onClick }: { active: boolean; running: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2',
        active && 'nav-selected',
      )}
    >
      <Dot color="var(--green)" pulse={running} size={9} />
      <span className="flex-1 truncate text-[12px] font-semibold text-text">Main</span>
      <span className="font-mono text-[8px] text-faint">planning</span>
    </button>
  );
}

/** The build lanes under THREADS — one row per thread. The live/failed/done tree, the triage lane, or (pre-
 *  approval) the draft threads. Flows directly under the Main lane row (no section header); the first OUTPUTS
 *  sub-group divider below separates it from the outputs. Each thread's subitems are its live task list (the
 *  SDK task tools) — see {@link PipelineTree}; submit-plan shows only the threads (no steps). */
function ThreadsTracks({
  status,
  job,
  messages,
  jobId,
  laneNode,
  onSelectNode,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  messages: JobMessage[];
  jobId: string;
  laneNode: string | null;
  onSelectNode: (node: string) => void;
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
  // drafts render as bare thread rows (dashed dots, no tasks). Empty (early planning) → the hint line.
  if (!job || job.threads.length === 0) {
    return (
      <p className="px-2 pb-1 pt-1 text-[11px] italic leading-relaxed text-faint">
        No build lanes yet — the plan you approve in the conversation is what creates them.
      </p>
    );
  }
  return (
    <PipelineTree
      job={job}
      status={status}
      messages={messages}
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
  context: ThreadContext | undefined;
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
        emptyText="No specs yet — plan.md & diagrams land here as Atlas drafts them."
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
        emptyText="Nothing generated yet — system-owned files like decision-record.md."
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      />

      {/* ARTIFACTS — real output files (preview HTML, screenshots). Diff + PR live in the header. */}
      <OutputGroup
        label="ARTIFACTS"
        files={artifacts}
        prefix="artifact"
        loading={loading}
        emptyText="Nothing shared yet — screenshots & output files land here as Atlas works."
        detailNode={detailNode}
        onSelectNode={onSelectNode}
      />
    </>
  );
}

/** One OUTPUTS sub-group (SPECS / ARTIFACTS / GENERATED) — its header is ALWAYS shown; the body is the
 *  files, a loading row, or a muted empty-state line. `children` renders above the files (the SPECS
 *  triaging provenance note). */
function OutputGroup({
  label,
  files,
  prefix,
  generated,
  loading,
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
  emptyText: string;
  detailNode: string | null;
  onSelectNode: (node: string) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <Divider label={label} count={files.length > 0 ? files.length : undefined} />
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
        <p className="px-2 pb-1 pt-1 text-[10.5px] italic leading-relaxed text-faint">{emptyText}</p>
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
          "N live" green indicator rides the count slot. */}
      <Divider
        label="PORTS"
        count={
          <span className="flex items-center gap-1 font-mono text-[8px] font-semibold text-green">
            <span className="pulse-dot h-[5px] w-[5px] rounded-full" style={{ background: 'var(--green)' }} />
            {ports.length} live
          </span>
        }
      />
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
  threadRef,
  onConversation,
}: {
  status: JobStatus;
  job: PipelineJob | null;
  threadRef: JobRef;
  onConversation: () => void;
}) {
  const retry = useRetryThread(threadRef);
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
function ThreadMenu({
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
                  onDelete();
                  setOpen(false);
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
