'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight, Info, PanelRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { useContextFile, useSay } from '@/lib/api/thread-queries';
import { trackTitle } from '@/lib/track-title';
import { VerdictButtons } from './approval-card';
import { Markdown } from './markdown';
import { pipelineJob, type ThreadMessage, type ThreadRef } from '@/lib/api/thread-api';
import {
  APPROVE_ACTION_ID,
  type ContextFileContent,
  type PipelineJob,
  type PipelineState,
  type WebApprovalCard,
} from '@/lib/api/types';

type PhaseTab = 'transcript' | 'diff' | 'logs';

/**
 * Step mode — the work column when a navigator node is selected. The plan / decision docs and the build
 * transcript/diff/logs render REAL data where the web API exposes it (the approved plan card's decisions +
 * tracks; the thread's `build_event` relays) and clearly-labeled PLACEHOLDERS where it doesn't (no
 * per-step transcript/diff/logs endpoint, no plan.md/decision-record content endpoint — see
 * `web/BACKEND_GAPS.md`).
 */
export function PhaseView({
  threadRef,
  pipeline,
  pipelineLoading,
  pipelineError,
  messages,
  approvalCard,
  selectedNode,
  onConversation,
  onSelectNode,
}: {
  threadRef: ThreadRef;
  pipeline: PipelineState | undefined;
  /** The pipeline query's loading / error state — needed to tell "still loading" from "node is gone". */
  pipelineLoading?: boolean;
  pipelineError?: boolean;
  messages: ThreadMessage[];
  approvalCard: WebApprovalCard | null;
  selectedNode: string;
  onConversation: () => void;
  /** Select another navigator node (URL `?node=`) — lets a rendered spec file's relative links open the
   *  linked file in-app. */
  onSelectNode?: (node: string) => void;
}) {
  const job = pipelineJob(pipeline);
  const track = job?.tracks.find((s) => s.id === selectedNode) ?? null;
  // A step leaf (execute folder) — find which track owns it + its 1-based index, for the label.
  const owningSection = job?.tracks.find((s) => s.steps.some((p) => p.id === selectedNode)) ?? null;
  const phaseIndex = owningSection ? owningSection.steps.findIndex((p) => p.id === selectedNode) : -1;
  const step = owningSection?.steps[phaseIndex] ?? null;

  // A `?node=` URL can outlive the node it names (deleted spec, a track/step id from before a re-plan).
  // Resolve EVERY job-derived token against the live job so a stale link shows NodeNotFound rather than a
  // misleading generic placeholder or a silently-empty build view. `spec:`/`artifact:` self-handle a 404
  // inside FileView; `plan`/`decision`/`diff` render from card/derived data and are always resolvable.
  const resolution = resolveNode(selectedNode, job, Boolean(pipelineLoading), Boolean(pipelineError));

  // Context-file nodes (specs / generated / artifacts) resolve to a single `/context` path. The header's
  // byte count reads from the same (cached) query FileView uses, so calling it here costs nothing extra.
  const filePath = selectedNode.startsWith('spec:')
    ? `specs/${selectedNode.slice('spec:'.length)}`
    : selectedNode.startsWith('gen:')
      ? `generated/${selectedNode.slice('gen:'.length)}`
      : selectedNode.startsWith('artifact:')
        ? `artifacts/${selectedNode.slice('artifact:'.length)}`
        : null;
  const fileQuery = useContextFile(threadRef, filePath);

  // The detail pane's header (title + subtitle) lives in the top bar — each branch supplies it alongside
  // its body so the scrolling content no longer repeats it.
  let title: string;
  let subtitle = '';
  let body: React.ReactNode;
  if (resolution === 'loading') {
    title = 'Loading…';
    body = <Placeholder title="Loading…" body="Resolving this node against the pipeline." />;
  } else if (resolution === 'not_found') {
    title = 'Not found';
    subtitle = selectedNode;
    body = <NodeNotFound node={selectedNode} onConversation={onConversation} />;
  } else if (selectedNode === 'plan') {
    const n = (approvalCard?.tracks ?? job?.tracks.map((s) => s.brief) ?? []).length;
    title = job?.title ?? approvalCard?.title ?? 'Plan';
    subtitle = `${n} track${n === 1 ? '' : 's'} · plan.md`;
    body = <PlanDoc card={approvalCard} tracks={job?.tracks.map((s) => s.brief)} threadRef={threadRef} />;
  } else if (selectedNode === 'decision') {
    title = 'Decision record';
    subtitle = "locked at approval · the build's input contract";
    body = <DecisionDoc card={approvalCard} />;
  } else if (selectedNode === 'diff') {
    title = 'Diff';
    subtitle = 'the accumulated change across all tracks';
    body = <DiffView />;
  } else if (filePath) {
    title = filePath.split('/').pop() ?? filePath;
    subtitle = fileQuery.data ? `${filePath} · ${formatBytes(fileQuery.data.size)}` : filePath;
    body = <FileView threadRef={threadRef} path={filePath} onSelectNode={onSelectNode} />;
  } else if (selectedNode.startsWith('secplan:')) {
    const id = selectedNode.slice('secplan:'.length);
    const sec = job?.tracks.find((s) => s.id === id) ?? null;
    title = sec ? trackTitle(sec.brief) : 'Track plan';
    subtitle = 'track plan';
    body = <SectionPlanDoc />;
  } else if (selectedNode.startsWith('rev:')) {
    const lens = selectedNode.split(':')[2] ?? 'review';
    title = lens;
    subtitle = 'review lens · over the track diff';
    body = <ReviewView lens={lens} />;
  } else if (selectedNode.startsWith('autofix:')) {
    title = 'Auto-fix';
    subtitle = '3-lens self-review · over the track diff';
    body = <AutoFixView />;
  } else if (step) {
    title = `step ${phaseIndex + 1}${step.title ? ` · ${step.title}` : ''}`;
    subtitle = 'Claude · execute';
    body = <BuildView threadRef={threadRef} messages={messages} phaseId={step.id} />;
  } else if (track) {
    title = `§ ${trackTitle(track.brief)}`;
    subtitle = 'Claude · execute';
    body = <BuildView threadRef={threadRef} messages={messages} />;
  } else {
    title = 'Build';
    subtitle = 'Claude · execute';
    body = <BuildView threadRef={threadRef} messages={messages} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-5">
        <div className="flex min-w-0 flex-col justify-center">
          <span className="truncate font-disp text-[13.5px] font-semibold leading-tight text-text">{title}</span>
          {subtitle ? (
            <span className="truncate font-mono text-[10px] leading-tight text-faint">{subtitle}</span>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}

// ── Build step (transcript / diff / logs) ───────────────────────────────────────────────────────
function BuildView({
  threadRef,
  messages,
  phaseId,
}: {
  threadRef: ThreadRef;
  messages: ThreadMessage[];
  /** When set, the transcript is filtered to this step's relayed events (meta.phaseId). */
  phaseId?: string;
}) {
  const [tab, setTab] = useState<PhaseTab>('transcript');
  const buildEvents = messages
    .filter(
      (m) =>
        m.kind === 'build_event' && (phaseId ? (m.meta?.phaseId as string | undefined) === phaseId : true),
    )
    .map((m) => m.text);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-3">
        <div className="flex gap-5 text-[12px] font-semibold">
          {(['transcript', 'diff', 'logs'] as PhaseTab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn('-mb-px border-b-2 pb-2.5 capitalize', tab === t ? 'border-accent text-accent' : 'border-transparent text-faint')}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="h-px w-full" style={{ background: 'var(--border)' }} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'transcript' ? (
          <Transcript lines={buildEvents} scoped={Boolean(phaseId)} />
        ) : (
          <Placeholder
            title={tab === 'diff' ? 'Diff' : 'Logs'}
            body={`The per-step ${tab} stream isn't exposed by the web surface yet. It will render here once the backend adds a step read endpoint.`}
          />
        )}
      </div>

      <InterjectBar threadRef={threadRef} />
    </div>
  );
}

function Transcript({ lines, scoped }: { lines: string[]; scoped?: boolean }) {
  return (
    <div className="flex max-w-[780px] flex-col gap-2 font-mono text-[12px]">
      <Banner
        text={
          scoped
            ? "This step's build-event relays (filtered by step). Diff & logs streams are still pending a backend endpoint."
            : 'Showing live build-event relays from the thread.'
        }
      />
      {lines.length === 0 ? (
        <p className="text-faint">No build activity relayed yet.</p>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="rounded-md border border-border bg-surface-2 px-3 py-2 text-dim">
            {line}
          </div>
        ))
      )}
      <span className="cursor-blink inline-block h-3.5 w-1.5" style={{ background: 'var(--accent)' }} aria-hidden />
    </div>
  );
}

/** Talks to the build session (via the thread). Pause / Revert are UI-only (no backend op route). */
function InterjectBar({ threadRef }: { threadRef: ThreadRef }) {
  const say = useSay(threadRef);
  const [text, setText] = useState('');
  const [queued, setQueued] = useState<string[]>([]);

  function send() {
    const trimmed = text.trim();
    if (!trimmed) return;
    say.mutate(trimmed);
    setQueued((q) => [...q, trimmed]);
    setText('');
  }

  return (
    <div
      className="shrink-0 border-t border-border px-5 py-3"
      style={{ background: 'color-mix(in srgb, var(--panel) 40%, transparent)' }}
    >
      {queued.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {queued.map((q, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] text-accent"
              style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
            >
              ⏳ {q.length > 40 ? `${q.slice(0, 39)}…` : q} <span className="text-faint">· folds next turn</span>
            </span>
          ))}
        </div>
      ) : null}
      <div className="mb-2 flex items-center gap-2">
        <button type="button" disabled className="rounded-md border border-border-2 px-3 py-1.5 text-[11px] text-dim opacity-60" title="Needs a backend pause route">
          ⏸ Pause
        </button>
        <button type="button" disabled className="rounded-md border border-border-2 px-3 py-1.5 text-[11px] text-dim opacity-60" title="Needs a backend revert route">
          ↩ Revert step
        </button>
      </div>
      <div
        className="flex items-center gap-2.5 rounded-lg border px-3 py-2"
        style={{ borderColor: 'var(--accent-line)', background: 'var(--surface-2)', boxShadow: '0 0 0 4px var(--accent-soft)' }}
      >
        <span className="font-mono text-[13px] text-accent">›</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
          placeholder="Interject this step — folded in at the next turn boundary, no restart…"
          className="flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-faint"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim() || say.isPending}
          className="rounded-md px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-45"
          style={{ background: 'linear-gradient(145deg, var(--accent), var(--accent-2))' }}
        >
          Interject
        </button>
      </div>
      <p className="mt-1.5 text-center font-mono text-[9px] text-faint">interjecting one coding session — not the thread&apos;s brain</p>
    </div>
  );
}

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────────
function PlanDoc({
  card,
  tracks,
  threadRef,
}: {
  card: WebApprovalCard | null;
  tracks?: string[];
  threadRef: ThreadRef;
}) {
  const decisions = card?.decisions ?? [];
  const sectionList = card?.tracks ?? tracks ?? [];
  const value = card?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? '';

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        {card?.summary ? (
          <p className="mb-6 whitespace-pre-wrap text-[14px] leading-relaxed text-text">{card.summary}</p>
        ) : null}

        <DocLabel>LOCKED DECISIONS</DocLabel>
        {decisions.length === 0 ? (
          <p className="mb-6 text-[12.5px] text-dim">
            The decision record is locked at approval — its classified rulings become the build&apos;s input
            contract. (Open <span className="font-mono">decision-record.md</span> in the navigator.)
          </p>
        ) : (
          <div className="mb-6 flex flex-col gap-2.5">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="whitespace-nowrap rounded border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em] text-dim">
                  {d.decisionClass.replace(/_/g, ' ')}
                </span>
                <span className="text-[13px] leading-relaxed text-text">
                  <span className="font-semibold">{d.title}</span> — {d.ruling}
                </span>
              </div>
            ))}
          </div>
        )}

        <DocLabel>SECTIONS</DocLabel>
        {sectionList.map((s, i) => (
          <div key={i} className="flex items-baseline gap-3 border-t py-2" style={{ borderColor: 'var(--hair)' }}>
            <span className="w-4 font-mono text-[11px] text-faint">{i + 1}</span>
            <span className="text-[13.5px] font-medium text-text">{trackTitle(s)}</span>
          </div>
        ))}

        {card && value ? (
          <div className="mt-6">
            <VerdictButtons threadRef={threadRef} value={value} approveLabel="Approve & build →" size="md" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DecisionDoc({ card }: { card: WebApprovalCard | null }) {
  const decisions = card?.decisions ?? [];
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        {decisions.length === 0 ? (
          <Placeholder
            title="Decision record"
            body="The locked decision record isn't exposed by the web surface yet. Each decision carries a class; new always-ask classes surfacing mid-build park the driver and ask you."
          />
        ) : (
          <div className="flex flex-col gap-3">
            {decisions.map((d, i) => (
              <div key={i} className="rounded-md border border-border bg-surface-2 px-3.5 py-3">
                <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-dim">{d.decisionClass.replace(/_/g, ' ')}</span>
                <p className="mt-1 text-[13px] font-semibold text-text">{d.title}</p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">{d.ruling}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionPlanDoc() {
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <Placeholder
          title="Track plan"
          body="The just-in-time track plan (its build steps) isn't exposed by the web surface yet. The planning step decides the step split when the track starts."
        />
      </div>
    </div>
  );
}

function AutoFixView() {
  const lenses = [
    { name: 'best-practices', note: 'A self-review lens over the track diff.' },
    { name: 'correctness', note: 'A self-review lens over the track diff.' },
    { name: 'consistency', note: 'A self-review lens over the track diff.' },
  ];
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="flex max-w-[760px] flex-col gap-3">
        <Banner text="The 3-lens auto-fix runs over the track diff, then commits the fixes. Per-lens results aren't exposed by the web surface yet." />
        {lenses.map((l) => (
          <div key={l.name} className="rounded-md border border-border bg-surface px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--faint)' }} />
              <span className="text-[12.5px] font-semibold text-text">{l.name}</span>
            </div>
            <p className="mt-1.5 font-mono text-[10.5px] text-dim">{l.note}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffView() {
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <Placeholder
          title="Diff"
          body="The accumulated diff isn't exposed by the web surface yet — it lives in the feature branch and lands in the PR. Open the pull request from ARTIFACTS to review the change on GitHub."
        />
      </div>
    </div>
  );
}

/** One review-agent lens (a self-review pass over the track diff). Findings are ephemeral (relayed to chat). */
function ReviewView({ lens }: { lens: string }) {
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[720px]">
        <Placeholder
          title={`${lens} review`}
          body="Review lenses run as parallel self-review passes over the track's diff; their findings are relayed into the conversation rather than persisted, so they aren't browsable here yet."
        />
      </div>
    </div>
  );
}

// ── Context file viewer (specs / artifacts) ───────────────────────────────────────────────────────
/** Render one real `/context` file: markdown → prose, images → inline, anything else → mono text. */
function FileView({
  threadRef,
  path,
  onSelectNode,
}: {
  threadRef: ThreadRef;
  path: string;
  onSelectNode?: (node: string) => void;
}) {
  const { data, isLoading, error } = useContextFile(threadRef, path);
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div className="max-w-[820px]">
        {isLoading ? (
          <p className="font-mono text-[11.5px] text-faint">Loading…</p>
        ) : error ? (
          <Placeholder
            title="Couldn’t load file"
            body={error instanceof Error ? error.message : 'Unknown error reading this file.'}
          />
        ) : data ? (
          <FileBody file={data} onSelectNode={onSelectNode} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Resolve a RELATIVE markdown link (e.g. `sections/01-backend.md`, `../data-model.md`) found inside a
 * `/context` file at `fromPath` (bucket-rooted, e.g. `specs/plan.md`) to the navigator node that opens it
 * (`spec:`/`gen:`/`artifact:` + the bucket-relative path). Returns null if it escapes a known bucket.
 */
function contextNodeForLink(fromPath: string, href: string): string | null {
  const parts = fromPath.split('/');
  const bucket = parts[0];
  const prefix = bucket === 'specs' ? 'spec:' : bucket === 'generated' ? 'gen:' : bucket === 'artifacts' ? 'artifact:' : null;
  if (!prefix) return null;
  const stack = parts.slice(1, -1); // dir of the current file, within the bucket
  for (const seg of href.split(/[?#]/)[0].split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  if (stack.length === 0) return null;
  return prefix + stack.join('/');
}

function FileBody({ file, onSelectNode }: { file: ContextFileContent; onSelectNode?: (node: string) => void }) {
  const pathname = usePathname();
  if (file.mime.startsWith('image/')) {
    const src =
      file.encoding === 'base64'
        ? `data:${file.mime};base64,${file.content}`
        : `data:${file.mime};utf8,${encodeURIComponent(file.content)}`;
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL, not a remote asset for next/image
    return <img src={src} alt={file.name} className="max-w-full rounded-md border border-border" />;
  }
  if (file.content.trim() === '') {
    return <p className="font-mono text-[11.5px] italic text-faint">This file is empty.</p>;
  }
  if (file.mime === 'text/markdown') {
    // Shared renderer — same dark terminal code frames + syntax highlighting as the conversation view.
    // Relative links (cross-spec, e.g. plan.md → sections/01-backend.md) open the target in-app instead
    // of letting the browser navigate the SPA route to a 404.
    return (
      <Markdown
        resolveRelativeLink={
          onSelectNode
            ? (href) => {
                const node = contextNodeForLink(file.path, href);
                if (!node) return null;
                return {
                  url: `${pathname}?node=${encodeURIComponent(node)}`,
                  onSelect: () => onSelectNode(node),
                };
              }
            : undefined
        }
      >
        {file.content}
      </Markdown>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 px-4 py-3 font-mono text-[12px] leading-relaxed text-dim">
      {file.content}
    </pre>
  );
}

// ── node resolution (stale `?node=` → not-found) ─────────────────────────────────────────────────
type NodeResolution = 'loading' | 'found' | 'not_found';

/** Literals that render from card / derived data — no live-id dependency, always resolvable. */
const ID_FREE_NODES = new Set(['plan', 'decision', 'diff']);

/**
 * Classify a `?node=` token against the live job. Job-derived tokens (`secplan:`/`rev:`/`autofix:` carry a
 * track id; a bare token is a track or step id) become `not_found` when their id is gone — otherwise a
 * stale URL would render a misleading generic placeholder or a silently-empty build view. `spec:`/`artifact:`
 * self-handle a missing file inside `FileView`, so they stay `found` here.
 */
function resolveNode(node: string, job: PipelineJob | null, loading: boolean, error: boolean): NodeResolution {
  if (ID_FREE_NODES.has(node)) return 'found';
  if (node.startsWith('spec:') || node.startsWith('gen:') || node.startsWith('artifact:')) return 'found';

  if (loading) return 'loading';
  if (error || !job) return 'not_found';

  if (node.startsWith('secplan:')) return hasSection(job, node.slice('secplan:'.length)) ? 'found' : 'not_found';
  if (node.startsWith('rev:')) return hasSection(job, node.split(':')[1] ?? '') ? 'found' : 'not_found';
  if (node.startsWith('autofix:')) return hasSection(job, node.slice('autofix:'.length)) ? 'found' : 'not_found';

  // Bare token — a track or a step leaf.
  const matches = job.tracks.some((s) => s.id === node || s.steps.some((p) => p.id === node));
  return matches ? 'found' : 'not_found';
}

function hasSection(job: PipelineJob, id: string): boolean {
  return id.length > 0 && job.tracks.some((s) => s.id === id);
}

/** A `?node=` that no longer resolves (deleted file, re-planned track/step). Placeholder styling — the
 *  designer will restyle/replace this. */
function NodeNotFound({ node, onConversation }: { node: string; onConversation: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-[14px] font-semibold text-text">This node isn’t here anymore</p>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-dim">
        The pane you linked to (<span className="font-mono text-[11.5px]">{node}</span>) is no longer part of
        this thread — it may have been removed or replaced when the plan changed.
      </p>
      <button
        type="button"
        onClick={onConversation}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-medium text-accent"
        style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
      >
        Clear this pane <ArrowRight size={13} />
      </button>
    </div>
  );
}

/**
 * The detail pane's resting state. The right pane is a CONSTANT container that never closes — when no
 * navigator node is selected it shows this instead of collapsing. Picking a file, track, or step from the
 * navigator fills it. Matches the PhaseView shell (header bar + body) so the container looks consistent.
 */
export function EmptyPane() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-5">
        <span className="font-mono text-[9px] tracking-[0.14em] text-faint">DETAIL</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border-2 text-faint">
          <PanelRight size={18} strokeWidth={1.6} />
        </div>
        <p className="text-[14px] font-semibold text-text">Nothing selected</p>
        <p className="mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-dim">
          Pick a file, track, or step from the navigator and it opens here. The conversation stays pinned on
          the left.
        </p>
      </div>
    </div>
  );
}

// ── shared bits ──────────────────────────────────────────────────────────────────────────────────
function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-[14px] font-semibold text-text">{title}</p>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-dim">{body}</p>
    </div>
  );
}

function Banner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-[11px] text-dim">
      <Info size={13} className="mt-px shrink-0 text-faint" />
      <span>{text}</span>
    </div>
  );
}

function DocLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 font-mono text-[9px] tracking-[0.14em] text-faint">{children}</div>;
}
