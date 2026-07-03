'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { ArrowRight, FileText, PanelRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes } from '@/lib/format';
import { useContextFile, useServices } from '@/lib/api/job-queries';
import { threadTitle } from '@/lib/thread-title';
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
import { useLiveTurn, type LiveTurn } from '@/lib/api/job-stream';
import { threadLane } from './phases';
import { codexReviewLane } from './codex-review';
import { autofixLensLane, autofixFixLane } from './review-lane';
import { resolveNode } from './node-resolution';
import { TranscriptView } from './conversation';
import { DetailTopBar } from './detail-top-bar';
import { ServiceLogView, serviceHeaderSubtitle } from './service-log-view';
import { useCommentableRef } from './use-text-selection';
import { useReviewComments } from './review-comments';
import { pipelineJob, type JobMessage, type JobRef } from '@/lib/api/job-api';
import {
  APPROVE_ACTION_ID,
  type ContextFileContent,
  type PipelineJob,
  type PipelineState,
  type WebApprovalCard,
} from '@/lib/api/types';


/**
 * Step mode — the work column when a navigator node is selected. The plan / decision docs and the build
 * transcript/diff/logs render REAL data where the web API exposes it (the approved plan card's decisions +
 * threads; the thread's `build_event` relays) and clearly-labeled PLACEHOLDERS where it doesn't (no
 * per-step transcript/diff/logs endpoint, no plan.md/decision-record content endpoint — see
 * `web/BACKEND_GAPS.md`).
 */
export function PhaseView({
  jobRef,
  pipeline,
  pipelineLoading,
  messages,
  approvalCard,
  selectedNode,
  onConversation,
  onSelectNode,
  tracksComments = false,
}: {
  jobRef: JobRef;
  pipeline: PipelineState | undefined;
  /** The pipeline query's loading state — needed to tell "still loading" from "node is gone" when no
   *  cached pipeline is available yet. */
  pipelineLoading?: boolean;
  messages: JobMessage[];
  approvalCard: WebApprovalCard | null;
  selectedNode: string;
  onConversation: () => void;
  /** Select another navigator node (URL `?node=`) — lets a rendered spec file's relative links open the
   *  linked file in-app. */
  onSelectNode?: (node: string) => void;
  /**
   * Only the RIGHT (detail) pane's `PhaseView` instance owns the review-comments `activeTarget` — the LEFT
   * (lane) instance's `selectedNode` is always a transcript lane (a bare thread/step id, or a
   * `rev:`/`fix:`/`codex-review:` child-thread lane), never a commentable file/doc (see
   * `use-selected-node.ts`'s `isDetailNode`), so it must NOT clear the right pane's active target to null
   * every time the operator switches lanes. Defaults false; `job-workspace.tsx` passes true only for the
   * `detailNode`-driven instance.
   */
  tracksComments?: boolean;
}) {
  // Subagent sub-pages stream live (a running subagent) and fall back to the durable transcript afterward.
  const liveTurn = useLiveTurn(jobRef.jobId);
  const job = pipelineJob(pipeline);
  const thread = job?.threads.find((s) => s.id === selectedNode) ?? null;
  // A step leaf (execute folder) — find which thread owns it + its 1-based index, for the label.
  const owningSection = job?.threads.find((s) => s.steps.some((p) => p.id === selectedNode)) ?? null;
  const phaseIndex = owningSection ? owningSection.steps.findIndex((p) => p.id === selectedNode) : -1;
  const step = owningSection?.steps[phaseIndex] ?? null;

  // A `?node=` URL can outlive the node it names (deleted spec, a thread/step id from before a re-plan).
  // Resolve EVERY job-derived token against the live job so a stale link shows NodeNotFound rather than a
  // misleading generic placeholder or a silently-empty build view. `spec:`/`artifact:` self-handle a 404
  // inside FileView; `plan`/`decision`/`diff` render from card/derived data and are always resolvable.
  const resolution = resolveNode(selectedNode, job, Boolean(pipelineLoading));

  // Context-file nodes (specs / generated / artifacts) resolve to a single `/context` path. The header's
  // byte count reads from the same (cached) query FileView uses, so calling it here costs nothing extra.
  const filePath = selectedNode.startsWith('spec:')
    ? `specs/${selectedNode.slice('spec:'.length)}`
    : selectedNode.startsWith('gen:')
      ? `generated/${selectedNode.slice('gen:'.length)}`
      : selectedNode.startsWith('artifact:')
        ? `artifacts/${selectedNode.slice('artifact:'.length)}`
        : null;
  const fileQuery = useContextFile(jobRef, filePath);
  // Cheap even when the node isn't a service — React Query dedupes against the navigator's own useServices
  // call (same query key), and gives ServiceLogView a real name/cmd for its header instead of the bare id.
  const servicesQuery = useServices(jobRef);

  // Comments can be authored on a spec/generated/artifact file, the plan, the decision record, or the
  // diff — every OTHER node (ports, subagents, transcripts) is read-only content, never text to review.
  // Excludes 'loading'/'not_found': nothing real is on screen to select from yet.
  const commentable =
    resolution !== 'loading' &&
    resolution !== 'not_found' &&
    (Boolean(filePath) || selectedNode === 'plan' || selectedNode === 'decision' || selectedNode === 'diff');
  const { setActiveTarget } = useReviewComments();

  // The detail pane's header (title + subtitle) lives in the top bar — each branch supplies it alongside
  // its body so the scrolling content no longer repeats it.
  let title: string;
  let subtitle = '';
  let body: React.ReactNode;
  // Every node type gets the standard search/copy/diff actions EXCEPT a live service log, where none of
  // them apply — set to `null` in that branch to suppress them entirely (see `DetailTopBar`'s `actions`).
  let actions: React.ReactNode | undefined;
  if (resolution === 'loading') {
    title = 'Loading…';
    body = <Placeholder title="Loading…" body="Resolving this node against the pipeline." />;
  } else if (resolution === 'not_found') {
    title = 'Not found';
    subtitle = selectedNode;
    body = <NodeNotFound node={selectedNode} onConversation={onConversation} />;
  } else if (selectedNode === 'plan') {
    const n = (approvalCard?.threads ?? job?.threads.map((s) => s.brief) ?? []).length;
    title = job?.title ?? approvalCard?.title ?? 'Plan';
    subtitle = `${n} thread${n === 1 ? '' : 's'} · plan.md`;
    body = <PlanDoc card={approvalCard} threads={job?.threads.map((s) => s.brief)} jobRef={jobRef} />;
  } else if (selectedNode === 'decision') {
    title = 'Decision record';
    subtitle = "locked at approval · the build's input contract";
    body = <DecisionDoc card={approvalCard} />;
  } else if (selectedNode === 'diff') {
    title = 'Diff';
    subtitle = 'the accumulated change across all threads';
    body = <DiffView />;
  } else if (selectedNode.startsWith('port:')) {
    const portMeta = PORT_META[selectedNode.slice('port:'.length)];
    title = portMeta?.name ?? 'Port';
    subtitle = portMeta?.sub ?? 'sandbox port';
    body = <PortView id={selectedNode.slice('port:'.length)} />;
  } else if (selectedNode.startsWith('service:')) {
    const svcId = selectedNode.slice('service:'.length);
    const svc = servicesQuery.data?.services.find((s) => s.id === svcId) ?? null;
    title = svc?.name ?? svcId;
    subtitle = serviceHeaderSubtitle(svc);
    body = <ServiceLogView jobRef={jobRef} id={svcId} />;
    actions = null;
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
  } else if (selectedNode.startsWith('codex-review:')) {
    const review = job?.codexReview ?? null;
    title = 'Codex review';
    subtitle = review
      ? [`${review.rounds} round${review.rounds === 1 ? '' : 's'}`, review.status].filter(Boolean).join(' · ')
      : 'the plan-review dialogue';
    // The SAME transcript renderer as Main — just no composer (Atlas replies to Codex via respond_to_review).
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={codexReviewLane(jobRef.jobId)}
        emptyText="No review activity yet — Codex’s reasoning appears here as it runs."
        onSelectNode={onSelectNode}
      />
    );
  } else if (selectedNode.startsWith('fix:')) {
    // POST-REVIEW FIXES — the auto-fix stage's fix turn (fix · apply · verify) over a thread's diff, on the
    // `autofix:<threadId>:fix` lane. SAME transcript renderer as a review lens. The fix turn is SKIPPED when
    // the diff was clean or no finding hit the fix threshold, so an empty transcript is a legitimate state,
    // handled by TranscriptView's emptyText (not a not-found).
    const fixKey = selectedNode.slice('fix:'.length);
    const fixThread = job?.threads.find((s) => s.id === fixKey) ?? null;
    title = 'Post-review fixes';
    subtitle = fixThread?.status === 'auto_fixing' ? 'applying fixes · verify' : 'fix · apply · verify';
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={autofixFixLane(fixKey)}
        emptyText="No fixes were needed — the review found nothing to change."
        onSelectNode={onSelectNode}
      />
    );
  } else if (filePath) {
    title = filePath.split('/').pop() ?? filePath;
    subtitle = fileQuery.data ? `${filePath} · ${formatBytes(fileQuery.data.size)}` : filePath;
    body = <FileView jobRef={jobRef} path={filePath} onSelectNode={onSelectNode} />;
  } else if (selectedNode.startsWith('secplan:')) {
    const id = selectedNode.slice('secplan:'.length);
    const sec = job?.threads.find((s) => s.id === id) ?? null;
    title = sec ? threadTitle(sec.brief) : 'Thread plan';
    subtitle = 'thread plan';
    body = <SectionPlanDoc />;
  } else if (selectedNode.startsWith('rev:')) {
    const [, threadKey, lensId = 'review'] = selectedNode.split(':');
    const revThread = job?.threads.find((s) => s.id === threadKey) ?? null;
    const agent = revThread?.reviewAgents?.find((a) => a.id === lensId) ?? null;
    title = agent?.label ?? lensId;
    subtitle = agent ? `review agent · ${agent.status}` : 'review agent · over the thread diff';
    // The SAME transcript renderer as Main/Codex review — the lens's own thinking/tool/text blocks, tagged
    // `meta.autofixId`+`meta.lensId` on its own `autofix:<autofixId>:<lensId>` lane.
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={autofixLensLane(threadKey, lensId)}
        emptyText="No review activity yet — this lens hasn’t run."
        onSelectNode={onSelectNode}
      />
    );
  } else if (step) {
    title = `step ${phaseIndex + 1}${step.title ? ` · ${step.title}` : ''}`;
    subtitle = 'Claude · execute';
    // A batch runs as ONE turn on its thread's STABLE lane, tagged with the ANCHOR step id. Subscribe to the
    // thread lane (live) and filter the durable log to this step's anchor. SAME renderer as Main; the build
    // instruction shows as the opening input bubble.
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={owningSection ? threadLane(owningSection.id) : threadLane(step.anchorStepId)}
        phaseIds={new Set([step.anchorStepId])}
        onSelectNode={onSelectNode}
        emptyText="No build activity yet — this step hasn’t run."
      />
    );
  } else if (thread) {
    title = thread.isMasterReview ? 'Master review' : `§ ${threadTitle(thread.brief)}`;
    subtitle = thread.isMasterReview ? 'Codex · whole-diff review & fix' : 'Claude · execute';
    // A build thread is a Claude Code session like Main — subscribe to its STABLE `thread:<id>` lane (no
    // guessing the active phase from pipeline status) and aggregate its steps' durable transcripts.
    const phaseIds = new Set(thread.steps.map((s) => s.anchorStepId));
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={threadLane(thread.id)}
        phaseIds={phaseIds}
        onSelectNode={onSelectNode}
        emptyText="No build activity yet — this thread hasn’t run."
      />
    );
  } else {
    title = 'Build';
    subtitle = 'Claude · execute';
    const phaseIds = new Set((job?.threads ?? []).flatMap((t) => t.steps.map((s) => s.anchorStepId)));
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane="__none__"
        phaseIds={phaseIds}
        onSelectNode={onSelectNode}
        emptyText="No build activity yet."
      />
    );
  }

  // Tell the shared review-comments context which file is open, so a fresh selection tags its comment
  // correctly and the committed highlight rebuilds for the newly-active file (see `review-comments.tsx`).
  // ONLY the tracking instance may do this — see the `tracksComments` doc comment above (the other
  // instance's `selectedNode` is always non-commentable and would otherwise clobber this to null on every
  // unrelated lane switch).
  useEffect(() => {
    if (!tracksComments) return;
    setActiveTarget(commentable ? { node: selectedNode, label: title } : null);
  }, [tracksComments, commentable, selectedNode, title, setActiveTarget]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <DetailTopBar title={title} subtitle={subtitle || undefined} actions={actions} />
      {/* Flex column so a `flex-1` body (TranscriptView) gets a bounded height and scrolls internally —
          a plain block wrapper leaves its `h-full` scroll child resolving against auto height (no scroll). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
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
  messages: JobMessage[];
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

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────────
function PlanDoc({
  card,
  threads,
  jobRef,
}: {
  card: WebApprovalCard | null;
  threads?: string[];
  jobRef: JobRef;
}) {
  const decisions = card?.decisions ?? [];
  const sectionList = card?.threads ?? threads ?? [];
  const value = card?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? '';
  const contentRef = useCommentableRef<HTMLDivElement>();

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div ref={contentRef} className="max-w-[720px]">
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
            <span className="text-[13.5px] font-medium text-text">{threadTitle(s)}</span>
          </div>
        ))}

        {card && value ? (
          <div className="mt-6">
            <VerdictButtons jobRef={jobRef} value={value} approveLabel="Approve & build →" size="md" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DecisionDoc({ card }: { card: WebApprovalCard | null }) {
  const decisions = card?.decisions ?? [];
  const contentRef = useCommentableRef<HTMLDivElement>();
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div ref={contentRef} className="max-w-[720px]">
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
          title="Thread plan"
          body="The just-in-time thread plan (its build steps) isn't exposed by the web surface yet. The planning step decides the step split when the thread starts."
        />
      </div>
    </div>
  );
}

function DiffView() {
  const contentRef = useCommentableRef<HTMLDivElement>();
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div ref={contentRef} className="max-w-[720px]">
        <Placeholder
          title="Diff"
          body="The accumulated diff isn't exposed by the web surface yet — it lives in the feature branch and lands in the PR. Open the pull request from ARTIFACTS to review the change on GitHub."
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
  jobRef,
  path,
  onSelectNode,
}: {
  jobRef: JobRef;
  path: string;
  onSelectNode?: (node: string) => void;
}) {
  const { data, isLoading, error } = useContextFile(jobRef, path);
  const contentRef = useCommentableRef<HTMLDivElement>();
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div ref={contentRef} className="max-w-[820px]">
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

/** A `?node=` that no longer resolves (deleted file, re-planned thread/step). Placeholder styling — the
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
 * A sub-agent (Task run) STACKED on top of the right pane — a second-level page. Opening a sub-agent keeps
 * the base detail node (`?node=`) selected in the navigator and preserved underneath; this renders the
 * sub-agent's transcript under a BREADCRUMB back to that base (design "Atlas Workspace HiFi" — the `sub`
 * header). `‹` / the base crumb / `×` all pop back to the base (`onBack`). `base` is the underlying detail
 * node's short label (null when the sub was opened over an empty pane).
 */
export function SubagentPane({
  jobRef,
  messages,
  parentId,
  lane,
  base,
  onBack,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  parentId: string;
  /** The lane the spawning Task anchor lives on — the subagent's blocks stream on THIS lane's live turn,
   *  never Main's (see {@link subagentNode}). */
  lane: string;
  base: string | null;
  onBack: () => void;
}) {
  const liveTurn = useLiveTurn(jobRef.jobId, lane);
  const summary =
    indexDurableSubagents(messages).summaryById.get(parentId) ??
    (liveTurn ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId) : undefined);
  const label = summary ? subagentLabel(summary.type) : 'Subagent';
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <button type="button" onClick={onBack} title="Back to base" className="flex items-center text-[17px] leading-none text-blue hover:opacity-80">
          ‹
        </button>
        {base ? (
          <button type="button" onClick={onBack} className="flex min-w-0 items-center gap-1.5 hover:opacity-80">
            <FileText size={12} className="shrink-0 text-blue" />
            <span className="max-w-[150px] truncate font-mono text-[10px] text-dim">{base}</span>
          </button>
        ) : null}
        <span className="text-[11px] font-semibold text-border-2">▸</span>
        <span
          className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px] text-[10px]"
          style={{ background: 'color-mix(in srgb, var(--blue) 13%, transparent)', color: 'var(--blue)' }}
        >
          ◈
        </span>
        <span className="truncate font-disp text-[11px] font-semibold text-text">{label}</span>
        <span className="shrink-0 font-mono text-[9px] text-faint">sub-agent</span>
        <span className="flex-1" />
        <button type="button" onClick={onBack} title="Close sub-agent" className="text-[15px] leading-none text-faint hover:text-text">
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubagentView messages={messages} liveTurn={liveTurn ?? null} parentId={parentId} />
      </div>
    </div>
  );
}

/**
 * The detail pane's resting state. The right pane is a CONSTANT container that never closes — when no
 * navigator node is selected it shows this instead of collapsing. Picking a file, thread, or step from the
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
          Pick a file, thread, or step from the navigator and it opens here. The conversation stays pinned on
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
