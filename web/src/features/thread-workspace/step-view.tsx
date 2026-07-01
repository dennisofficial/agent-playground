'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight, PanelRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { useContextFile, useSay } from '@/lib/api/thread-queries';
import { trackTitle } from '@/lib/track-title';
import { VerdictButtons } from './approval-card';
import { Markdown } from './markdown';
import { MessageTime, StreamTextBubble, ThinkingBlock, UserBubble } from './bubbles';
import { JumpToLatestButton, useTailFollow } from './tail-follow';
import { ToolGroup, segmentToolRun, type ToolItem } from './tool-calls';
import {
  durableSubBlocks,
  durableSubagentPrompt,
  indexDurableSubagents,
  indexLiveSubagents,
  liveSubBlocksForParent,
  liveSubagentPrompt,
  subagentLabel,
  subagentModel,
  type SubBlock,
} from './subagents';
import { useLiveTurn, type LiveTurn } from '@/lib/api/thread-stream';
import { durablePhaseBlocks, indexPhaseBlocks, livePhaseBlocks, phaseLane } from './phases';
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
  // Subagent sub-pages stream live (a running subagent) and fall back to the durable transcript afterward.
  const liveTurn = useLiveTurn(threadRef.threadId);
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
  } else if (selectedNode.startsWith('port:')) {
    const portMeta = PORT_META[selectedNode.slice('port:'.length)];
    title = portMeta?.name ?? 'Port';
    subtitle = portMeta?.sub ?? 'sandbox port';
    body = <PortView id={selectedNode.slice('port:'.length)} />;
  } else if (selectedNode.startsWith('subagent:')) {
    const parentId = selectedNode.slice('subagent:'.length);
    const summary =
      indexDurableSubagents(messages).summaryById.get(parentId) ??
      (liveTurn ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId) : undefined);
    const model = summary ? subagentModel(summary.type) : undefined;
    title = summary ? subagentLabel(summary.type) : 'Subagent';
    subtitle = summary
      ? [`subagent · ${summary.type}`, summary.background ? 'background' : null, model, summary.running ? 'running' : 'done']
          .filter(Boolean)
          .join(' · ')
      : parentId;
    body = <SubagentView messages={messages} liveTurn={liveTurn ?? null} parentId={parentId} />;
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
    const [, trackId, lensId = 'review'] = selectedNode.split(':');
    const revTrack = job?.tracks.find((s) => s.id === trackId) ?? null;
    const agent = revTrack?.reviewAgents?.find((a) => a.id === lensId) ?? null;
    const lensLabel = agent?.label ?? lensId;
    title = lensLabel;
    subtitle = agent ? `review agent · ${agent.status}` : 'review agent · over the track diff';
    body = <ReviewView lens={lensLabel} />;
  } else if (step) {
    title = `step ${phaseIndex + 1}${step.title ? ` · ${step.title}` : ''}`;
    subtitle = 'Claude · execute';
    // A batch runs as ONE turn whose transcript is tagged with the ANCHOR step id — remap so a non-anchor
    // step in the batch resolves the same transcript (and live lane) instead of rendering empty.
    body = <BuildView threadRef={threadRef} messages={messages} anchorStepId={step.anchorStepId} />;
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
/**
 * The build step's work pane. The TRANSCRIPT tab renders the SAME full transcript a subagent run does
 * (thinking + prose via the canonical Markdown + tool calls) via {@link SubagentTranscript} — the phase
 * rides the shared spine, so its durable blocks (tagged `meta.phaseId`) and its live `phase:<id>` lane
 * feed the identical renderer. During the build the live lane is the sole source; the durable rows take
 * over after the turn ends.
 */
function BuildView({
  threadRef,
  messages,
  anchorStepId,
}: {
  threadRef: ThreadRef;
  messages: ThreadMessage[];
  /** The batch's ANCHOR step id — its transcript tag + live lane. Unset = the track/whole-build view. */
  anchorStepId?: string;
}) {
  const [tab, setTab] = useState<PhaseTab>('transcript');
  const index = indexPhaseBlocks(messages);
  // The live lane for THIS phase. Hooks can't be conditional, so an unset anchor reads a dead lane (→ none).
  const live = useLiveTurn(threadRef.threadId, anchorStepId ? phaseLane(anchorStepId) : '__none__');
  const active = Boolean(live?.active);

  // The build instruction the engine received — the turn's "first message". Persisted on the `build_anchor`
  // row at batch start, so it's available throughout the build (mirrors a subagent run's Task prompt).
  const prompt = anchorStepId ? index.anchorByPhase.get(anchorStepId)?.prompt : undefined;

  let blocks: SubBlock[];
  if (anchorStepId) {
    const durable = durablePhaseBlocks(index, anchorStepId);
    // Prefer durable (post-turn); fall back to the live lane while building (mirrors SubagentView).
    blocks = durable.length ? durable : live ? livePhaseBlocks(live.blocks) : [];
  } else {
    // Track / whole-build view: every phase's durable transcript, in message order (no single live lane).
    blocks = durableSubBlocks(messages.filter((m) => m.meta?.phaseId != null && m.kind !== 'build_anchor'));
  }

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
          <div className="mx-auto max-w-[820px]">
            {/* The build instruction that kicked off the turn — its "first message", like a subagent's prompt. */}
            {prompt ? <UserBubble text={prompt} /> : null}
            {blocks.length === 0 ? (
              prompt ? null : (
                <p className="text-[12.5px] text-faint">
                  {active ? 'Building…' : 'No build activity yet — this step hasn’t run.'}
                </p>
              )
            ) : (
              <SubagentTranscript blocks={blocks} active={active} />
            )}
            {active ? (
              <div className="mt-3 flex items-center gap-2 text-[11.5px] text-accent">
                <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
                <span>Building — the transcript streams live and persists when the step finishes.</span>
              </div>
            ) : null}
          </div>
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

// ── Subagent run (its own sub-page) ──────────────────────────────────────────────────────────────
/**
 * The detail-pane view for one subagent (Task) run. Renders the subagent's OWN transcript — its thinking,
 * narration, and tool calls — peeled out of the main conversation by `meta.parentToolUseId`. Prefers the
 * durable transcript (post-turn); falls back to the live blocks while the subagent is still running.
 * Read-only: the operator steers the brain, not the subagent.
 */
function SubagentView({
  messages,
  liveTurn,
  parentId,
}: {
  messages: ThreadMessage[];
  liveTurn: LiveTurn | null;
  parentId: string;
}) {
  const durable = indexDurableSubagents(messages);
  const durableKids = durable.childrenById.get(parentId) ?? [];
  const summary =
    durable.summaryById.get(parentId) ??
    (liveTurn ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId) : undefined);
  const blocks: SubBlock[] = durableKids.length
    ? durableSubBlocks(durableKids)
    : liveTurn
      ? liveSubBlocksForParent(liveTurn.blocks, parentId)
      : [];
  // The durable anchor isn't persisted until the turn ends, so fall back to the live blocks — otherwise the
  // Task prompt (the run's "first message") is blank for the whole time the subagent is streaming.
  const prompt =
    durableSubagentPrompt(messages, parentId) ||
    (liveTurn ? liveSubagentPrompt(liveTurn.blocks, parentId) : '');
  const active = Boolean(liveTurn?.active && summary?.running);
  const model = summary ? subagentModel(summary.type) : undefined;

  // Tail-follow this run's transcript while it streams — same behavior as the conversation. The stream
  // signature folds in growing text so it keeps following token-by-token, not just on block boundaries.
  const streamSig = blocks.reduce((n, b) => n + (b.kind === 'tool' ? 1 : b.text.length), 0);
  const tail = useTailFollow([blocks.length, streamSig, active]);

  return (
    <div className="relative h-full min-h-0">
      <div ref={tail.scrollRef} onScroll={tail.onScroll} className="h-full overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-[820px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {summary ? <Chip>{summary.type}</Chip> : null}
            {summary?.background ? <Chip>background</Chip> : null}
            {model ? <Chip>{model}</Chip> : null}
            <Chip>read-only</Chip>
          </div>

          {/* The Task prompt that kicked the run off — rendered as the operator's "user message" to the
              subagent, identical to the main conversation transcript. */}
          {prompt ? <UserBubble text={prompt} /> : null}

          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">Agent transcript</span>
          {blocks.length === 0 ? (
            <p className="text-[12.5px] text-faint">No activity yet.</p>
          ) : (
            <SubagentTranscript blocks={blocks} active={active} />
          )}
          {active ? (
            <div className="flex items-center gap-2 text-[11.5px] text-accent">
              <span className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
              <span>
                {summary ? subagentLabel(summary.type) : 'Subagent'} is working — its result posts back into the
                conversation when it finishes.
              </span>
            </div>
          ) : null}
          <p className="pt-1 font-mono text-[10px] text-faint">
            read-only view of the subagent — you’re not steering it here
          </p>
          <div ref={tail.endRef} />
        </div>
      </div>
      {tail.showJump ? <JumpToLatestButton onClick={tail.jumpToLatest} style={{ bottom: 16 }} /> : null}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm bg-surface-3 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-dim">
      {children}
    </span>
  );
}

/** Render a subagent's normalized transcript — consecutive tool blocks collapse into one group. */
function SubagentTranscript({ blocks, active }: { blocks: SubBlock[]; active: boolean }) {
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let pending: ToolItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending)) items.push({ key: `tg-${seg[0].key}`, node: <ToolGroup tools={seg} /> });
    pending = [];
  };
  for (const b of blocks) {
    if (b.kind === 'tool') {
      pending.push({ key: b.key, name: b.name, input: b.input, result: b.result, isError: b.isError, structuredPatch: b.structuredPatch as ToolItem['structuredPatch'], running: b.running });
      continue;
    }
    flush();
    if (b.kind === 'text')
      items.push({
        key: b.key,
        node: (
          <div className="group flex flex-col gap-0.5">
            <StreamTextBubble text={b.text} streaming={Boolean(b.running) && active} />
            <MessageTime iso={b.postedAt} tone="muted" />
          </div>
        ),
      });
    else
      items.push({
        key: b.key,
        node: <ThinkingBlock text={b.text} streaming={Boolean(b.running) && active} time={b.postedAt} />,
      });
  }
  flush();
  return (
    <div className="flex flex-col gap-[9px]">
      {items.map((it) => (
        <div key={it.key}>{it.node}</div>
      ))}
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
                <ProvenanceBadge confirmed={d.confirmedByOperator} />
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
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-dim">{d.decisionClass.replace(/_/g, ' ')}</span>
                  <ProvenanceBadge confirmed={d.confirmedByOperator} />
                </div>
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

// ── Sandbox ports (design-stage MOCK — no backend port-exposure yet) ───────────────────────────────
/**
 * The PORTS detail views are a faithful design-stage MOCK: the backend has Docker port-mapping plumbing
 * but no port discovery/proxy/request-log yet, so these render representative placeholder data behind a
 * clear "design preview" footnote. When the sandbox exposes real ports, swap the mock bodies for live data.
 */
interface PortMeta {
  kind: 'web' | 'server';
  name: string;
  sub: string;
  url?: string;
  app?: 'billing' | 'admin';
}

const PORT_META: Record<string, PortMeta> = {
  billing: { kind: 'web', name: 'Billing UI', sub: 'Web · :3000', url: 'localhost:3000/billing', app: 'billing' },
  admin: { kind: 'web', name: 'Admin', sub: 'Web · :3002', url: 'localhost:3002/admin', app: 'admin' },
  api: { kind: 'server', name: 'API server', sub: 'Server · :8080' },
};

function PortView({ id }: { id: string }) {
  const meta = PORT_META[id];
  if (!meta) return <Placeholder title="Port" body="Unknown sandbox port." />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        {meta.kind === 'server' ? <ServerPortView /> : <WebPortView url={meta.url ?? ''} app={meta.app ?? 'billing'} />}
      </div>
      <PortMockFootnote />
    </div>
  );
}

function PortMockFootnote() {
  return (
    <div className="shrink-0 border-t border-border px-5 py-2 text-center font-mono text-[9px] text-faint">
      design preview · live sandbox ports are not exposed by the backend yet
    </div>
  );
}

/** A framed browser preview of a dev-server web app (mock body). */
function WebPortView({ url, app }: { url: string; app: 'billing' | 'admin' }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border-2 bg-panel" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-3" style={{ background: 'var(--surface-2)' }}>
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--red)' }} />
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--accent)' }} />
        <span className="h-[7px] w-[7px] rounded-full" style={{ background: 'var(--green)' }} />
        <span className="ml-2 flex-1 truncate rounded-md bg-panel px-3 py-1 font-mono text-[9px] text-dim">{url}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-panel">
        {app === 'billing' ? <MockBillingApp /> : <MockAdminApp />}
      </div>
    </div>
  );
}

function MockBillingApp() {
  const invoices = [
    { date: 'Jul 1, 2025', amount: '$49.00', state: 'PAID' as const },
    { date: 'Jun 1, 2025', amount: '$49.00', state: 'PAID' as const },
    { date: 'May 1, 2025', amount: '$49.00', state: 'FAILED' as const },
  ];
  return (
    <div className="px-8 py-7">
      <div className="text-[19px] font-bold text-text">Billing</div>
      <div className="mt-0.5 text-[12px] text-dim">Manage your subscription and invoices</div>
      <div className="mt-5 flex items-center justify-between rounded-xl border border-border px-4 py-4" style={{ background: 'var(--surface-2)' }}>
        <div>
          <div className="text-[14px] font-semibold text-text">Pro plan</div>
          <div className="text-[11px] text-dim">Renews Aug 1 · billed monthly</div>
        </div>
        <div className="text-[18px] font-bold text-text">
          $49<span className="text-[11px] font-medium text-dim">/mo</span>
        </div>
      </div>
      <div className="mb-2 mt-6 font-mono text-[10px] tracking-[0.08em] text-faint">RECENT INVOICES</div>
      <div className="overflow-hidden rounded-xl border border-border">
        {invoices.map((inv, i) => (
          <div
            key={inv.date}
            className={cn('flex items-center px-4 py-3 text-[12px]', i > 0 && 'border-t border-border')}
          >
            <span className="flex-1 text-dim">{inv.date}</span>
            <span className="mr-4 font-semibold text-text">{inv.amount}</span>
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold"
              style={
                inv.state === 'PAID'
                  ? { color: 'var(--green)', background: 'var(--green-soft)' }
                  : { color: 'var(--red)', background: 'var(--red-soft)' }
              }
            >
              {inv.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MockAdminApp() {
  const stats = [
    { label: 'MRR', value: '$24.8k', tone: 'text' as const },
    { label: 'ACTIVE', value: '506', tone: 'text' as const },
    { label: 'FAILED 24H', value: '7', tone: 'red' as const },
  ];
  const events = [
    { name: 'invoice.paid', code: '200' },
    { name: 'customer.subscription.updated', code: '200' },
    { name: 'invoice.payment_failed', code: '200' },
  ];
  return (
    <div className="px-7 py-6">
      <div className="mb-5 text-[17px] font-bold text-text">Admin · Billing ops</div>
      <div className="mb-6 flex gap-3">
        {stats.map((s) => (
          <div key={s.label} className="flex-1 rounded-xl border border-border px-4 py-3" style={{ background: 'var(--surface-2)' }}>
            <div className="font-mono text-[9px] text-faint">{s.label}</div>
            <div className={cn('mt-1 text-[19px] font-bold', s.tone === 'red' ? 'text-red' : 'text-text')}>{s.value}</div>
          </div>
        ))}
      </div>
      <div className="mb-2 font-mono text-[10px] tracking-[0.08em] text-faint">RECENT WEBHOOK EVENTS</div>
      <div className="overflow-hidden rounded-xl border border-border">
        {events.map((e, i) => (
          <div key={e.name} className={cn('flex items-center px-4 py-2.5 text-[11px]', i > 0 && 'border-t border-border')}>
            <span className="flex-1 font-mono text-[10px] text-blue">{e.name}</span>
            <span className="font-mono text-[9px] text-green">{e.code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A live-styled request log for a server dev port (mock rows). */
function ServerPortView() {
  const log = [
    { time: '09:42:01', method: 'POST', path: '/webhook', status: '200', ms: '34ms' },
    { time: '09:41:58', method: 'POST', path: '/webhook', status: '200', ms: '12ms' },
    { time: '09:41:55', method: 'GET', path: '/health', status: '200', ms: '2ms' },
    { time: '09:41:50', method: 'POST', path: '/webhook', status: '400', ms: '8ms' },
    { time: '09:41:47', method: 'POST', path: '/webhook', status: '200', ms: '29ms' },
    { time: '09:41:42', method: 'GET', path: '/billing/invoices', status: '200', ms: '41ms' },
    { time: '09:41:39', method: 'POST', path: '/webhook', status: '200', ms: '18ms' },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border-2 bg-panel">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-green">
          <span className="h-2 w-2 rounded-full" style={{ background: 'var(--green)', boxShadow: '0 0 0 3px var(--green-soft)' }} />
          Running
        </span>
        <span className="font-mono text-[9.5px] text-dim">:8080 · node · uptime 2h 14m</span>
        <span className="flex-1" />
        <span className="font-mono text-[9px] text-faint">142 req/min</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        <div className="px-5 pb-2 font-mono text-[8px] tracking-[0.1em] text-faint">REQUEST LOG · LIVE</div>
        {log.map((r, i) => (
          <div key={i} className="flex items-center gap-3 whitespace-pre px-5 py-1 font-mono text-[10.5px]">
            <span className="text-faint">{r.time}</span>
            <span className="w-9" style={{ color: r.method === 'POST' ? 'var(--blue)' : 'var(--green)' }}>{r.method}</span>
            <span className="flex-1 truncate text-dim">{r.path}</span>
            <span style={{ color: r.status === '200' ? 'var(--green)' : 'var(--red)' }}>{r.status}</span>
            <span className="w-12 text-right text-faint">{r.ms}</span>
          </div>
        ))}
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
 * Classify a `?node=` token against the live job. Job-derived tokens (`secplan:`/`rev:` carry a
 * track id; a bare token is a track or step id) become `not_found` when their id is gone — otherwise a
 * stale URL would render a misleading generic placeholder or a silently-empty build view. `spec:`/`artifact:`
 * self-handle a missing file inside `FileView`, so they stay `found` here.
 */
function resolveNode(node: string, job: PipelineJob | null, loading: boolean, error: boolean): NodeResolution {
  if (ID_FREE_NODES.has(node)) return 'found';
  if (node.startsWith('spec:') || node.startsWith('gen:') || node.startsWith('artifact:')) return 'found';
  // Subagent runs aren't job nodes — they self-handle a missing run inside SubagentView. Always resolvable.
  if (node.startsWith('subagent:')) return 'found';
  // Sandbox ports are a design-stage mock (no backend port-exposure yet) — always resolvable.
  if (node.startsWith('port:')) return 'found';

  if (loading) return 'loading';
  if (error || !job) return 'not_found';

  if (node.startsWith('secplan:')) return hasSection(job, node.slice('secplan:'.length)) ? 'found' : 'not_found';
  // `rev:<trackId>:<agentId>` — found only when the track still exists AND still selects that review
  // agent. With the agent list now dynamic, a stale agent id must not render a plausible-but-wrong page.
  if (node.startsWith('rev:')) {
    const [, trackId, lensId] = node.split(':');
    const revTrack = trackId ? job.tracks.find((s) => s.id === trackId) : undefined;
    return revTrack && lensId && (revTrack.reviewAgents ?? []).some((a) => a.id === lensId)
      ? 'found'
      : 'not_found';
  }
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

function DocLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2.5 font-mono text-[9px] tracking-[0.14em] text-faint">{children}</div>;
}

/**
 * Provenance chip — whether the operator actually confirmed a decision, or Atlas authored the default.
 * Surfaces under-grilling at the gate: an `Atlas-authored` decision is one the operator never explicitly
 * decided, so they can scrutinise it before approving.
 */
function ProvenanceBadge({ confirmed }: { confirmed?: boolean }) {
  return confirmed ? (
    <span
      className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em]"
      style={{
        color: 'var(--green, #15803d)',
        background: 'color-mix(in srgb, var(--green, #15803d) 12%, transparent)',
      }}
    >
      confirmed
    </span>
  ) : (
    <span
      className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em]"
      style={{
        color: 'var(--amber, #b45309)',
        background: 'color-mix(in srgb, var(--amber, #b45309) 12%, transparent)',
      }}
    >
      Atlas-authored
    </span>
  );
}
