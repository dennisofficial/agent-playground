'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  FileText,
  GitBranch,
  GitPullRequest,
  Image as ImageIcon,
  Lock,
  MoreHorizontal,
  Pause,
  Pencil,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { KindBadge, StatusPie } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import { formatBytes } from '@/lib/format';
import { trackTitle } from '@/lib/track-title';
import { cn } from '@/lib/cn';
import { pipelineJob } from '@/lib/api/thread-api';
import { Caret, Divider, PipelineTree, haltTrackIdx } from './pipeline-tree';
import { NavigatorApprovalCallout } from './spec-approval';
import type { ContextFile, PipelineJob, PipelineState, ThreadContext, ThreadKind, ThreadStatus } from '@/lib/api/types';
import type { ThreadRef } from '@/lib/api/thread-api';

export interface ThreadMeta {
  title: string;
  kind: ThreadKind;
  status: ThreadStatus;
  orgName: string;
  /** Org swatch fill — neutral grey now (handoff). */
  orgColor: string;
  repoName: string;
  tracker?: string;
  footer: string;
}

/**
 * The 288px thread navigator — ONE constant skeleton kept for the thread's whole lifecycle: a header
 * over Conversation → CONTEXT → PIPELINE → ARTIFACTS. The skeleton never restructures; only the signals
 * inside change (dot color, dimming, the selected row, per-region notes). See the thread-sidebar handoff.
 */
export function Navigator({
  meta,
  pipeline,
  context,
  contextLoading,
  selectedNode,
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
  /** The thread's `/context` files (specs + artifacts) — feeds the SPECS + ARTIFACTS panels. */
  context: ThreadContext | undefined;
  contextLoading?: boolean;
  selectedNode: string | null;
  /** The open thread — for the in-place "Approve plan" callout. */
  threadRef: ThreadRef;
  /** The approval card's verbatim approve `value`, when the thread is awaiting approval (else ''). Drives
   *  the navigator approval callout. */
  approveValue: string;
  /** Clears the detail-pane selection (used by the state banners' recovery actions). */
  onConversation: () => void;
  onSelectNode: (node: string) => void;
  onRename?: (title: string) => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const job = pipelineJob(pipeline);
  const branch = job?.featureBranch ?? job?.baseBranch ?? undefined;
  const [editing, setEditing] = useState(false);

  // Per-folder expand/collapse — explicit user overrides over the status-derived defaults. Keyed by
  // folder id (sec:<id>, sec:<id>.exec, sec:<id>.rev); stale keys from a previous thread never match.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isExpanded = (id: string, fallback: boolean) => (id in collapsed ? !collapsed[id] : fallback);
  const toggle = (id: string, currentlyExpanded: boolean) =>
    setCollapsed((m) => ({ ...m, [id]: currentlyExpanded }));

  const st = meta.status;

  return (
    <div
      className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border"
      style={{ background: 'color-mix(in srgb, var(--panel) 35%, transparent)' }}
    >
      {/* ── header ──────────────────────────────────────────────────────────────────────────── */}
      <div className="border-b border-border px-4 py-3.5">
        <div className="mb-2 flex items-center gap-2">
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
            className="w-full rounded border border-border-2 bg-surface px-1.5 py-0.5 font-disp text-[16px] font-semibold text-text outline-none focus:border-accent"
            aria-label="Thread title"
          />
        ) : (
          <div className="font-disp text-[16px] font-semibold leading-tight tracking-[-0.01em] text-text">
            {meta.title}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <span className="h-[7px] w-[7px] shrink-0 rounded-sm" style={{ background: meta.orgColor }} />
          <span className="font-mono text-[9.5px] text-dim">{meta.orgName}</span>
          <span className="text-[9px] text-border-2">/</span>
          <span className="font-mono text-[9.5px] font-semibold">{meta.repoName}</span>
        </div>
        {branch || meta.tracker ? (
          <div className="mt-1.5 flex items-center gap-2 font-mono text-[9.5px] text-faint">
            {branch ? (
              <span className="flex items-center gap-1 truncate">
                <GitBranch size={10} className="shrink-0" />
                {branch}
              </span>
            ) : null}
            {meta.tracker ? (
              <>
                <span className="text-border-2">·</span>
                <span className="text-blue">{meta.tracker} ↗</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── scroll body — the constant skeleton ─────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-3">
        {st === 'awaiting_approval' && approveValue ? (
          <NavigatorApprovalCallout threadRef={threadRef} value={approveValue} />
        ) : (
          <StateBanner status={st} job={job} onConversation={onConversation} />
        )}

        <SpecsRegion
          status={st}
          specs={context?.specs}
          loading={contextLoading}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />

        <GeneratedRegion
          generated={context?.generated}
          loading={contextLoading}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />

        <PipelineRegion
          status={st}
          job={job}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          isExpanded={isExpanded}
          toggle={toggle}
        />

        <ArtifactsRegion
          status={st}
          job={job}
          artifacts={context?.artifacts}
          loading={contextLoading}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
        />
      </div>

      <div className="border-t border-border px-3.5 py-2.5 text-[10px] leading-relaxed text-faint">
        {meta.footer}
      </div>
    </div>
  );
}

// ── SPECS (the plan files: plan.md, decision-record.md, diagrams) ──────────────────────────────────

function SpecsRegion({
  status,
  specs,
  loading,
  selectedNode,
  onSelectNode,
}: {
  status: ThreadStatus;
  specs: ContextFile[] | undefined;
  loading?: boolean;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const files = specs ?? [];
  return (
    <>
      <Divider label="SPECS" count={files.length > 0 ? files.length : undefined} />
      {/* An untrusted-seeded thread keeps its provenance note above the (usually empty) spec list. */}
      {status === 'triaging' ? (
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
          <p className="text-[10.5px] leading-snug text-dim">An untrusted notification seeded this thread.</p>
        </div>
      ) : null}
      {files.length > 0 ? (
        files.map((f) => (
          <FileRow
            key={f.name}
            icon={fileIcon(f.name)}
            name={f.name}
            active={selectedNode === `spec:${f.name}`}
            onClick={() => onSelectNode(`spec:${f.name}`)}
            note={{ text: formatBytes(f.size) }}
          />
        ))
      ) : loading ? (
        <LoadingRow label="Loading specs…" />
      ) : (
        <EmptyRow text="No spec files yet — plan.md & diagrams appear here as the agent drafts them." />
      )}
    </>
  );
}

// ── GENERATED (system-owned, read-only: decision-record.md) ──────────────────────────────────────────

function GeneratedRegion({
  generated,
  loading,
  selectedNode,
  onSelectNode,
}: {
  generated: ContextFile[] | undefined;
  loading?: boolean;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const files = generated ?? [];
  // Only show the region once there's something generated — keeps the empty navigator quiet.
  if (files.length === 0 && !loading) return null;
  return (
    <>
      <Divider label="GENERATED" count={files.length > 0 ? files.length : undefined} />
      {files.length > 0 ? (
        files.map((f) => (
          <FileRow
            key={f.name}
            icon={<Lock size={12} className="shrink-0" style={{ color: 'var(--slate)' }} />}
            name={f.name}
            active={selectedNode === `gen:${f.name}`}
            onClick={() => onSelectNode(`gen:${f.name}`)}
            note={{ text: formatBytes(f.size) }}
          />
        ))
      ) : (
        <LoadingRow label="Loading…" />
      )}
    </>
  );
}

// ── PIPELINE (the work tree) ───────────────────────────────────────────────────────────────────────

function PipelineRegion({
  status,
  job,
  selectedNode,
  onSelectNode,
  isExpanded,
  toggle,
}: {
  status: ThreadStatus;
  job: PipelineJob | null;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
  isExpanded: (id: string, fallback: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean) => void;
}) {
  // Triaging — the autonomous lane: triage findings, not a build tree.
  if (status === 'triaging') {
    return (
      <>
        <Divider label="PIPELINE" count="triage only" />
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

  // The live build tree (running / paused / done / failed) — real tracks + steps.
  if ((status === 'running' || status === 'paused' || status === 'done' || status === 'failed') && job) {
    const total = job.tracks.length;
    const activeIdx = job.tracks.findIndex(
      (s) => s.status !== 'done' && s.status !== 'pending' && s.status !== 'failed',
    );
    const activeNo = activeIdx === -1 ? total : activeIdx + 1;
    const count =
      status === 'done' ? (
        <span className="text-green">{total} / {total}</span>
      ) : status === 'failed' ? (
        <span className="text-red">stopped</span>
      ) : (
        `§${Math.min(activeNo, total || 1)} / ${total}`
      );
    return (
      <>
        <Divider label="PIPELINE" count={count} />
        <PipelineTree
          job={job}
          status={status}
          selectedNode={selectedNode}
          onSelectNode={onSelectNode}
          isExpanded={isExpanded}
          toggle={toggle}
        />
      </>
    );
  }

  // Planning / awaiting — draft tracks (locked in on approval). The plan is now authored in full up
  // front, so a proposed track already carries its steps — show them (expandable) so the operator can
  // review the whole shape before approving, not just the track titles. Older step-less drafts (and
  // the planning state, before any tracks exist) degrade to a plain title row.
  const drafts = job?.tracks ?? [];
  const proposed = status === 'awaiting_approval';
  return (
    <>
      <Divider label="PIPELINE" count={proposed ? `proposed · ${drafts.length}` : 'forming'} />
      {drafts.length === 0 ? (
        <p className="px-2 pb-1 pt-1 text-[11px] italic leading-relaxed text-faint">
          No tracks yet — the plan you approve in the conversation is what creates them.
        </p>
      ) : (
        drafts.map((s, i) => {
          const steps = s.steps ?? [];
          const folderId = `draft:${s.id}`;
          // Default to expanded while proposed so the full plan is visible at a glance.
          const expanded = steps.length > 0 && isExpanded(folderId, proposed);
          return (
            <div key={s.id} className="select-none">
              <div
                className={cn(
                  'flex items-center gap-[7px] px-2 py-1.5 opacity-60',
                  steps.length > 0 && 'cursor-pointer hover:opacity-80',
                )}
                onClick={steps.length > 0 ? () => toggle(folderId, expanded) : undefined}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ border: '1.5px dashed var(--border-2)', background: 'transparent' }}
                />
                <span className="flex-1 truncate text-[12px] font-semibold text-dim">
                  §{i + 1} {trackTitle(s.brief)}
                </span>
                {s.type && s.type !== 'general' && (
                  <span className="shrink-0 rounded-sm bg-surface-3 px-1 font-mono text-[8.5px] uppercase tracking-wide text-faint">
                    {s.type}
                  </span>
                )}
                {steps.length > 0 && (
                  <span className="shrink-0 font-mono text-[9.5px] text-faint">{steps.length}</span>
                )}
                {steps.length > 0 ? <Caret expanded={expanded} /> : null}
              </div>
              {expanded &&
                steps.map((p, pi) => (
                  <div key={p.id} className="flex items-center gap-2 py-1 pl-[23px] pr-2 opacity-55">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ border: '1px dashed var(--border-2)', background: 'transparent' }}
                    />
                    <span className="flex-1 truncate text-[11px] text-dim">
                      {i + 1}.{pi + 1} {p.title || `Step ${pi + 1}`}
                    </span>
                  </div>
                ))}
            </div>
          );
        })
      )}
      <p className="px-2 pb-1 pt-2 text-[10.5px] italic leading-relaxed text-faint">
        Drafted in the conversation — these lock in when you approve the plan.
      </p>
    </>
  );
}

// ── ARTIFACTS (outputs) ────────────────────────────────────────────────────────────────────────────

function ArtifactsRegion({
  status,
  job,
  artifacts,
  loading,
  selectedNode,
  onSelectNode,
}: {
  status: ThreadStatus;
  job: PipelineJob | null;
  artifacts: ContextFile[] | undefined;
  loading?: boolean;
  selectedNode: string | null;
  onSelectNode: (node: string) => void;
}) {
  const hasPr = Boolean(job?.prUrl);
  // The diff + PR are derived from the pipeline / thread row (NOT the files endpoint).
  const populated = status === 'done' || hasPr;
  const files = artifacts ?? [];

  return (
    <>
      <Divider label="ARTIFACTS" count={files.length > 0 ? files.length : undefined} />
      {populated ? (
        <>
          <FileRow
            icon={<span className="text-[12px] leading-none">±</span>}
            name="diff"
            dim
            active={selectedNode === 'diff'}
            onClick={() => onSelectNode('diff')}
          />
          {hasPr ? (
            <a
              href={job!.prUrl!}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-surface-2"
            >
              <GitPullRequest size={12} className="text-green" />
              <span className="flex-1 truncate font-mono text-[11px] text-green">
                {job!.prNumber != null ? `PR #${job!.prNumber}` : 'pull request'} · open
              </span>
              <ArrowUpRight size={12} className="text-faint" />
            </a>
          ) : null}
        </>
      ) : null}
      {/* Real output files dropped into /context/artifacts (preview HTML, screenshots, …). */}
      {files.map((f) => (
        <FileRow
          key={f.name}
          icon={fileIcon(f.name)}
          name={f.name}
          active={selectedNode === `artifact:${f.name}`}
          onClick={() => onSelectNode(`artifact:${f.name}`)}
          note={{ text: formatBytes(f.size) }}
        />
      ))}
      {!populated && files.length === 0 ? (
        loading ? (
          <LoadingRow label="Loading artifacts…" />
        ) : (
          <div className="flex flex-col items-center gap-1.5 px-2 py-3 text-center">
            <span className="text-[15px] opacity-40">🗂</span>
            <span className="text-[10px] leading-relaxed text-faint">
              Nothing shared yet — the agent drops screenshots &amp; files here as it works.
            </span>
          </div>
        )
      ) : null}
    </>
  );
}

// ── state banners (failed / paused) ──────────────────────────────────────────────────────────────

function StateBanner({
  status,
  job,
  onConversation,
}: {
  status: ThreadStatus;
  job: PipelineJob | null;
  onConversation: () => void;
}) {
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
          <BannerBtn tone="red" icon={<RotateCw size={10} />} label="Retry" onClick={onConversation} />
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
          <BannerBtn tone="accent" icon={<RotateCw size={10} />} label="Re-ping" onClick={onConversation} />
        </div>
      </div>
    );
  }
  if (status === 'awaiting_approval') {
    return (
      <div
        className="mx-1.5 my-1 flex items-start gap-2 rounded-md border border-l-2 px-3 py-2.5"
        style={{ borderColor: 'var(--border)', borderLeftColor: 'var(--slate)', background: 'var(--surface-2)' }}
      >
        <Lock size={12} className="mt-px shrink-0" style={{ color: 'var(--slate)' }} />
        <div>
          <div className="text-[11px] font-semibold" style={{ color: 'var(--slate)' }}>
            Approval card is in the conversation
          </div>
          <p className="mt-0.5 text-[10.5px] leading-snug text-dim">
            That card is the gate — approving locks in the plan below.
          </p>
          <button
            type="button"
            onClick={onConversation}
            className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-semibold"
            style={{ color: 'var(--accent)' }}
          >
            Open conversation <ArrowRight size={11} />
          </button>
        </div>
      </div>
    );
  }
  return null;
}

function haltSectionNo(job: PipelineJob): number | null {
  const idx = haltTrackIdx(job.tracks);
  return idx === -1 ? null : idx + 1;
}

function BannerBtn({
  tone,
  icon,
  label,
  onClick,
}: {
  tone: 'red' | 'accent' | 'neutral';
  icon?: ReactNode;
  label: string;
  onClick: () => void;
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
      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[10px] font-semibold"
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
        active ? 'bg-[var(--accent-soft)]' : ''
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

/** A region's empty-state note (no files yet). */
function EmptyRow({ text }: { text: string }) {
  return <p className="px-2 pb-1 pt-1 text-[10.5px] italic leading-relaxed text-faint">{text}</p>;
}

/** Kebab → "Rename thread" + a two-click "Delete thread" (real `PATCH` / `DELETE …/threads/:id`). */
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
        aria-label="Thread actions"
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
              Rename thread
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
              {deleting ? 'Deleting…' : confirm ? 'Click again to confirm' : 'Delete thread'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
