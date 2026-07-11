"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowRight, Check, Copy, FileText, PanelRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import {
  useContextFile,
  useRepoFile,
  useRepoTree,
  useServices,
} from "@/lib/api/job-queries";
import { threadTitle } from "@/lib/thread-title";
import { VerdictButtons } from "./approval-card";
import { Markdown } from "./markdown";
import {
  MessageTime,
  StreamTextBubble,
  ThinkingBlock,
  UserBubble,
} from "./bubbles";
import { JumpToLatestButton, useTailFollow } from "./tail-follow";
import { ToolGroup, segmentToolRun, type ToolItem } from "./tool-calls";
import { CodeListing } from "./tool-calls/ui";
import { langFromPath } from "./tool-calls/highlight";
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
} from "./subagents";
import { useLiveTurn, type LiveTurn } from "@/lib/api/job-stream";
import { threadLane } from "./phases";
import { contextConvoNodeForHref, parseLegNode } from "./node-registry";
import { codexReviewLane } from "./codex-review";
import { resolveNode } from "./node-resolution";
import { TranscriptView } from "./conversation";
import { Composer, type ComposerFooter } from "./composer";
import { DetailTopBar, TopBarActions, TopBarButton } from "./detail-top-bar";
import { ImageViewer } from "./image-viewer";
import {
  LogFileView,
  ServiceLogView,
  serviceHeaderSubtitle,
} from "./service-log-view";
import { TicketsRaisedPane } from "./tickets-raised-pane";
import { useCommentableRef } from "./use-text-selection";
import { useReviewComments } from "./review-comments";
import { makeResolveFileLink } from "./repo-file-links";
import {
  contextRawUrl,
  pipelineJob,
  type JobMessage,
  type JobRef,
} from "@/lib/api/job-api";
import {
  APPROVE_ACTION_ID,
  type ContextFileContent,
  type PipelineState,
  type WebApprovalCard,
} from "@/lib/api/types";

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
  onBack,
  onOpenNav,
  onOpenDetail,
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
  /** Drawer-backed detail views use this as the visible back affordance that clears `?node=`. */
  onBack?: () => void;
  /** Below xl: top-bar toggles for the Navigator / Detail drawers (undefined = no button, desktop). */
  onOpenNav?: () => void;
  onOpenDetail?: () => void;
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
  // A review CHILD thread (a `review_lens` / `post_review` row) — matched by its own bare id (no `rev:`/
  // `fix:` prefix). Carries the transcript lane the backend computed for it.
  const reviewChild =
    job?.threads
      .flatMap((s) => s.children ?? [])
      .find((c) => c.id === selectedNode) ?? null;
  // A per-Leg node (`<threadId>~leg<ordinal>`) — a rotated build session rendered as its own thread. Resolve
  // its owning thread; the transcript is the thread's lane sliced to this Leg's `meta.legOrdinal`.
  const legRef = parseLegNode(selectedNode);
  const legThread = legRef
    ? (job?.threads.find((s) => s.id === legRef.threadId) ?? null)
    : null;
  // A step leaf (execute folder) — find which thread owns it + its 1-based index, for the label.
  const owningSection =
    job?.threads.find((s) => s.steps.some((p) => p.id === selectedNode)) ??
    null;
  const phaseIndex = owningSection
    ? owningSection.steps.findIndex((p) => p.id === selectedNode)
    : -1;
  const step = owningSection?.steps[phaseIndex] ?? null;

  // A `?node=` URL can outlive the node it names (deleted spec, a thread/step id from before a re-plan).
  // Resolve EVERY job-derived token against the live job so a stale link shows NodeNotFound rather than a
  // misleading generic placeholder or a silently-empty build view. `spec:`/`artifact:` self-handle a 404
  // inside FileView; `plan`/`decision`/`diff` render from card/derived data and are always resolvable.
  const resolution = resolveNode(selectedNode, job, Boolean(pipelineLoading));

  // Context-file nodes (specs / generated / artifacts) resolve to a single `/context` path. The header's
  // byte count reads from the same (cached) query FileView uses, so calling it here costs nothing extra.
  const filePath = selectedNode.startsWith("spec:")
    ? `specs/${selectedNode.slice("spec:".length)}`
    : selectedNode.startsWith("gen:")
      ? `generated/${selectedNode.slice("gen:".length)}`
      : selectedNode.startsWith("artifact:")
        ? `artifacts/${selectedNode.slice("artifact:".length)}`
        : null;
  const fileQuery = useContextFile(jobRef, filePath);
  // Cheap even when the node isn't a service — React Query dedupes against the navigator's own useServices
  // call (same query key), and gives ServiceLogView a real name/cmd for its header instead of the bare id.
  const servicesQuery = useServices(jobRef);

  // Comments can be authored on a spec/generated/artifact file, the plan, the decision record, or the
  // diff — every OTHER node (ports, subagents, transcripts) is read-only content, never text to review.
  // Excludes 'loading'/'not_found': nothing real is on screen to select from yet.
  const commentable =
    resolution !== "loading" &&
    resolution !== "not_found" &&
    (Boolean(filePath) ||
      selectedNode === "plan" ||
      selectedNode === "decision" ||
      selectedNode === "diff");
  const { setActiveTarget } = useReviewComments();

  // The detail pane's header (title + subtitle) lives in the top bar — each branch supplies it alongside
  // its body so the scrolling content no longer repeats it.
  let title: string;
  let subtitle = "";
  let body: React.ReactNode;
  // Every node type gets the standard search/copy/diff actions EXCEPT a live service log, where none of
  // them apply — set to `null` in that branch to suppress them entirely (see `DetailTopBar`'s `actions`).
  let actions: React.ReactNode | undefined;
  if (resolution === "loading") {
    title = "Loading…";
    body = (
      <Placeholder
        title="Loading…"
        body="Resolving this node against the pipeline."
      />
    );
  } else if (resolution === "not_found") {
    title = "Not found";
    subtitle = selectedNode;
    body = <NodeNotFound node={selectedNode} onConversation={onConversation} />;
  } else if (selectedNode === "plan") {
    const n = (approvalCard?.threads ?? job?.threads.map((s) => s.brief) ?? [])
      .length;
    title = job?.title ?? approvalCard?.title ?? "Plan";
    subtitle = `${n} thread${n === 1 ? "" : "s"} · plan.md`;
    body = (
      <PlanDoc
        card={approvalCard}
        threads={job?.threads.map((s) => s.brief)}
        jobRef={jobRef}
        onSelectNode={onSelectNode}
      />
    );
  } else if (selectedNode === "decision") {
    title = "Decision record";
    subtitle = "locked at approval · the build's input contract";
    body = <DecisionDoc card={approvalCard} />;
  } else if (selectedNode === "diff") {
    title = "Diff";
    subtitle = "the accumulated change across all threads";
    body = <DiffView />;
  } else if (selectedNode === "tickets") {
    title = "Tickets raised";
    subtitle = "out-of-scope work Atlas captured from this job";
    body = <TicketsRaisedPane jobRef={jobRef} />;
  } else if (selectedNode.startsWith("service:")) {
    const svcId = selectedNode.slice("service:".length);
    const svc =
      servicesQuery.data?.services.find((s) => s.id === svcId) ?? null;
    title = svc?.name ?? svcId;
    subtitle = serviceHeaderSubtitle(svc);
    body = <ServiceLogView jobRef={jobRef} id={svcId} />;
    actions = null;
  } else if (selectedNode.startsWith("subagent:")) {
    const parentId = selectedNode.slice("subagent:".length);
    const summary =
      indexDurableSubagents(messages).summaryById.get(parentId) ??
      (liveTurn
        ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId)
        : undefined);
    const model = summary ? subagentModel(summary.type) : undefined;
    title = summary ? subagentLabel(summary.type) : "Subagent";
    subtitle = summary
      ? [
          `subagent · ${summary.type}`,
          summary.background ? "background" : null,
          model,
          summary.running ? "running" : "done",
        ]
          .filter(Boolean)
          .join(" · ")
      : parentId;
    body = (
      <SubagentView
        jobRef={jobRef}
        messages={messages}
        liveTurn={liveTurn ?? null}
        parentId={parentId}
      />
    );
  } else if (selectedNode.startsWith("codex-review:")) {
    title = "Codex review";
    subtitle = "the plan-review dialogue";
    // The SAME transcript renderer as Main — the synchronous `review_plan` turn streams on this lane.
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={codexReviewLane(jobRef.jobId)}
        composer
        readOnly
        defaultFooter={job?.planReview?.defaultFooter}
        emptyText="No review activity yet — Codex’s reasoning appears here as it runs."
        onSelectNode={onSelectNode}
      />
    );
  } else if (reviewChild) {
    // A REVIEW CHILD thread — a review lens or the post-review fix (fix · apply · verify), each on its own
    // `autofix:<parentId>:<lensId>` / `autofix:<parentId>:fix` lane (carried on the child's pipeline data).
    // SAME transcript renderer as Main/Codex review. An empty transcript is legitimate (a lens/fix that
    // hasn't run / found nothing) — handled by TranscriptView's emptyText, not a not-found.
    const isFix = reviewChild.kind === "post_review";
    title = isFix ? "Post-review fixes" : reviewChild.brief;
    subtitle = isFix
      ? reviewChild.status === "executing" ||
        reviewChild.status === "auto_fixing"
        ? "applying fixes · verify"
        : "fix · apply · verify"
      : `review agent · ${reviewChild.status}`;
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={reviewChild.lane}
        composer
        readOnly
        defaultFooter={reviewChild.defaultFooter}
        emptyText={
          isFix
            ? "No fixes were needed — the review found nothing to change."
            : "No review activity yet — this lens hasn’t run."
        }
        onSelectNode={onSelectNode}
      />
    );
  } else if (filePath) {
    title = filePath.split("/").pop() ?? filePath;
    subtitle = fileQuery.data
      ? `${filePath} · ${formatBytes(fileQuery.data.size)}`
      : filePath;
    actions = (
      <TopBarActions copySlot={<FileCopyButton file={fileQuery.data} />} />
    );
    body = (
      <FileView jobRef={jobRef} path={filePath} onSelectNode={onSelectNode} />
    );
  } else if (selectedNode.startsWith("secplan:")) {
    const id = selectedNode.slice("secplan:".length);
    const sec = job?.threads.find((s) => s.id === id) ?? null;
    title = sec ? threadTitle(sec.brief) : "Thread plan";
    subtitle = "thread plan";
    body = <SectionPlanDoc />;
  } else if (step) {
    title = `step ${phaseIndex + 1}${step.title ? ` · ${step.title}` : ""}`;
    subtitle = "Claude · execute";
    // A batch runs as ONE turn on its thread's STABLE lane, tagged with the ANCHOR step id. Subscribe to the
    // thread lane (live) and filter the durable log to this step's anchor. SAME renderer as Main; the build
    // instruction shows as the opening input bubble.
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={
          owningSection
            ? threadLane(owningSection.id)
            : threadLane(step.anchorStepId)
        }
        phaseIds={new Set([step.anchorStepId])}
        composer
        readOnly
        defaultFooter={owningSection?.defaultFooter}
        onSelectNode={onSelectNode}
        emptyText="No build activity yet — this step hasn’t run."
      />
    );
  } else if (thread) {
    title = thread.isMasterReview
      ? "Master review"
      : `§ ${threadTitle(thread.brief)}`;
    subtitle = thread.isMasterReview
      ? "Codex · whole-diff review & fix"
      : "Claude · execute";
    // A build thread is a Claude Code session like Main — subscribe to its STABLE `thread:<id>` lane (no
    // guessing the active phase from pipeline status) and aggregate its steps' durable transcripts.
    const phaseIds = new Set(thread.steps.map((s) => s.anchorStepId));
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={threadLane(thread.id)}
        phaseIds={phaseIds}
        composer
        readOnly
        defaultFooter={thread.defaultFooter}
        onSelectNode={onSelectNode}
        emptyText="No build activity yet — this thread hasn’t run."
      />
    );
  } else if (legThread && legRef) {
    title = `§ ${threadTitle(legThread.brief)} · Leg ${legRef.ordinal}`;
    subtitle = "Claude · execute";
    // One rotated session: the thread's stable lane, sliced to this Leg. Its handoff (Leg N) and continuation
    // seed (Leg N+1) ride the same `meta.legOrdinal` tag, so they land at the tail/head of the right Leg.
    const phaseIds = new Set(legThread.steps.map((s) => s.anchorStepId));
    // The in-flight turn is shared across the thread's Legs (one lane), so only the LIVE Leg's pane may render
    // it — otherwise a rotated Leg re-paints the active Leg's streaming tail + spinner at its own bottom.
    const legIsLive =
      (legThread.legs ?? []).find((l) => l.ordinal === legRef.ordinal)
        ?.status === "active";
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane={threadLane(legThread.id)}
        phaseIds={phaseIds}
        legOrdinal={legRef.ordinal}
        legIsLive={legIsLive}
        composer
        readOnly
        defaultFooter={legThread.defaultFooter}
        onSelectNode={onSelectNode}
        emptyText="No activity on this Leg yet."
      />
    );
  } else {
    title = "Build";
    subtitle = "Claude · execute";
    const phaseIds = new Set(
      (job?.threads ?? []).flatMap((t) => t.steps.map((s) => s.anchorStepId)),
    );
    body = (
      <TranscriptView
        jobRef={jobRef}
        messages={messages}
        lane="__none__"
        phaseIds={phaseIds}
        composer
        readOnly
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
      <DetailTopBar
        title={title}
        subtitle={subtitle || undefined}
        actions={actions}
        onBack={onBack}
        onOpenNav={onOpenNav}
        onOpenDetail={onOpenDetail}
      />
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
  jobRef,
  messages,
  liveTurn,
  parentId,
}: {
  jobRef: JobRef;
  messages: JobMessage[];
  liveTurn: LiveTurn | null;
  parentId: string;
}) {
  const durable = indexDurableSubagents(messages);
  const durableKids = durable.childrenById.get(parentId) ?? [];
  const summary =
    durable.summaryById.get(parentId) ??
    (liveTurn
      ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId)
      : undefined);
  const blocks: SubBlock[] = durableKids.length
    ? durableSubBlocks(durableKids)
    : liveTurn
      ? liveSubBlocksForParent(liveTurn.blocks, parentId)
      : [];
  // The durable anchor isn't persisted until the turn ends, so fall back to the live blocks — otherwise the
  // Task prompt (the run's "first message") is blank for the whole time the subagent is streaming.
  const prompt =
    durableSubagentPrompt(messages, parentId) ||
    (liveTurn ? liveSubagentPrompt(liveTurn.blocks, parentId) : "");
  const active = Boolean(liveTurn?.active && summary?.running);
  const model = summary ? subagentModel(summary.type) : undefined;

  // The read-only footer bar (reused Composer, `subagent` variant): this subagent's OWN model + context ring.
  // Prefer LIVE occupancy (from `subUsage[parentId]`, while running) over the durable summary (post-turn),
  // mirroring the subagent card's enrichment in bubbles.tsx.
  const su = liveTurn?.subUsage?.[parentId];
  const ctxTokens = su?.contextTokens ?? summary?.contextTokens;
  const ctxLimit = su?.contextLimit ?? summary?.contextLimit;
  const ctxModel = su?.contextModel ?? summary?.contextModel;
  const footer: ComposerFooter = {
    model: ctxModel ?? subagentModel(summary?.type ?? ""),
    context:
      typeof ctxTokens === "number" &&
      typeof ctxLimit === "number" &&
      ctxLimit > 0
        ? { tokens: ctxTokens, limit: ctxLimit, model: ctxModel }
        : null,
  };
  const [composerHeight, setComposerHeight] = useState(72);

  // Tail-follow this run's transcript while it streams — same behavior as the conversation. The stream
  // signature folds in growing text so it keeps following token-by-token, not just on block boundaries.
  const streamSig = blocks.reduce(
    (n, b) => n + (b.kind === "tool" ? 1 : b.text.length),
    0,
  );
  const tail = useTailFollow([blocks.length, streamSig, active]);

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={tail.scrollRef}
        onScroll={tail.onScroll}
        onPointerOver={tail.onPointerOver}
        onPointerLeave={tail.onPointerLeave}
        className="h-full overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto flex max-w-[820px] flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {summary ? <Chip>{summary.type}</Chip> : null}
            {summary?.background ? <Chip>background</Chip> : null}
            {model ? <Chip>{model}</Chip> : null}
          </div>

          {/* The Task prompt that kicked the run off — rendered as the operator's "user message" to the
              subagent, identical to the main conversation transcript. */}
          {prompt ? <UserBubble text={prompt} /> : null}

          <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">
            Agent transcript
          </span>
          {blocks.length === 0 ? (
            <p className="text-[12.5px] text-faint">No activity yet.</p>
          ) : (
            <SubagentTranscript blocks={blocks} active={active} />
          )}
          {active ? (
            <div className="flex items-center gap-2 text-[11.5px] text-accent">
              <span
                className="pulse-dot h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: "var(--accent)" }}
              />
              <span>
                {summary ? subagentLabel(summary.type) : "Subagent"} is working
                — its result posts back into the conversation when it finishes.
              </span>
            </div>
          ) : null}
          <div ref={tail.endRef} />
          {/* Reserve space so the last transcript lines clear the absolute footer bar below. */}
          <div
            className="shrink-0"
            style={{ height: composerHeight }}
            aria-hidden
          />
        </div>
      </div>
      {/* Read-only footer bar — the reused Composer in `subagent` variant (no input/send; model + ring). */}
      <Composer
        variant="subagent"
        jobRef={jobRef}
        footer={footer}
        onHeightChange={setComposerHeight}
      />
      {tail.showJump ? (
        <JumpToLatestButton
          onClick={tail.jumpToLatest}
          style={{ bottom: composerHeight + 8 }}
        />
      ) : null}
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
function SubagentTranscript({
  blocks,
  active,
}: {
  blocks: SubBlock[];
  active: boolean;
}) {
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  let pending: ToolItem[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    for (const seg of segmentToolRun(pending))
      items.push({ key: `tg-${seg[0].key}`, node: <ToolGroup tools={seg} /> });
    pending = [];
  };
  for (const b of blocks) {
    if (b.kind === "tool") {
      pending.push({
        key: b.key,
        name: b.name,
        input: b.input,
        result: b.result,
        isError: b.isError,
        structuredPatch: b.structuredPatch as ToolItem["structuredPatch"],
        running: b.running,
      });
      continue;
    }
    flush();
    if (b.kind === "text")
      items.push({
        key: b.key,
        node: (
          <div className="group flex flex-col gap-0.5">
            <StreamTextBubble
              text={b.text}
              streaming={Boolean(b.running) && active}
            />
            <MessageTime iso={b.postedAt} tone="muted" />
          </div>
        ),
      });
    else
      items.push({
        key: b.key,
        node: (
          <ThinkingBlock
            text={b.text}
            streaming={Boolean(b.running) && active}
            time={b.postedAt}
          />
        ),
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
  onSelectNode,
}: {
  card: WebApprovalCard | null;
  threads?: string[];
  jobRef: JobRef;
  /** Select another navigator node (URL `?node=`/`?file=`) — lets the plan summary's file-path spans open
   *  the stacked repo-file view in-app. */
  onSelectNode?: (node: string) => void;
}) {
  const decisions = card?.decisions ?? [];
  const sectionList = card?.threads ?? threads ?? [];
  const value =
    card?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? "";
  const contentRef = useCommentableRef<HTMLDivElement>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoTree = useRepoTree(jobRef);
  const fileSet = useMemo(
    () => new Set(repoTree.data?.files ?? []),
    [repoTree.data],
  );

  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div ref={contentRef} className="max-w-[720px]">
        {card?.summary ? (
          <div className="mb-6">
            <Markdown
              resolveFileLink={
                onSelectNode
                  ? makeResolveFileLink(
                      fileSet,
                      pathname,
                      searchParams,
                      onSelectNode,
                    )
                  : undefined
              }
            >
              {card.summary}
            </Markdown>
          </div>
        ) : null}

        <DocLabel>LOCKED DECISIONS</DocLabel>
        {decisions.length === 0 ? (
          <p className="mb-6 text-[12.5px] text-dim">
            The decision record is locked at approval — its classified rulings
            become the build&apos;s input contract. (Open{" "}
            <span className="font-mono">decision-record.md</span> in the
            navigator.)
          </p>
        ) : (
          <div className="mb-6 flex flex-col gap-2.5">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="whitespace-nowrap rounded border border-border bg-surface-3 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em] text-dim">
                  {d.decisionClass.replace(/_/g, " ")}
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
          <div
            key={i}
            className="flex items-baseline gap-3 border-t py-2"
            style={{ borderColor: "var(--hair)" }}
          >
            <span className="w-4 font-mono text-[11px] text-faint">
              {i + 1}
            </span>
            <span className="text-[13.5px] font-medium text-text">
              {threadTitle(s)}
            </span>
          </div>
        ))}

        {card && value ? (
          <div className="mt-6">
            <VerdictButtons
              jobRef={jobRef}
              value={value}
              approveLabel="Approve & build →"
              size="md"
            />
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
              <div
                key={i}
                className="rounded-md border border-border bg-surface-2 px-3.5 py-3"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-dim">
                    {d.decisionClass.replace(/_/g, " ")}
                  </span>
                  <ProvenanceBadge confirmed={d.confirmedByOperator} />
                </div>
                <p className="mt-1 text-[13px] font-semibold text-text">
                  {d.title}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-dim">
                  {d.ruling}
                </p>
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
  const repoTree = useRepoTree(jobRef);
  const fileSet = useMemo(
    () => new Set(repoTree.data?.files ?? []),
    [repoTree.data],
  );
  const linkRepoFiles = path.startsWith("specs/");
  // HTML and images render full-bleed: they fill the whole pane body, bypassing the padded prose wrapper.
  if (data?.mime === "text/html") {
    return <HtmlFileBody file={data} jobRef={jobRef} />;
  }
  if (data?.mime.startsWith("image/")) {
    return <ImageFileBody file={data} />;
  }
  // `.log` artifacts render full-bleed in the same ANSI terminal frame as live service logs, so escape
  // codes come through as colors instead of literal `\x1b[..m` garbage in a plain <pre>.
  if (data && data.name.endsWith(".log")) {
    return <LogFileView content={data.content} />;
  }
  // Everything else fills the pane width; only markdown keeps the readable max-width so long prose lines
  // don't sprawl edge-to-edge.
  return (
    <div className="h-full overflow-y-auto px-8 py-7">
      <div
        ref={contentRef}
        className={data?.mime === "text/markdown" ? "max-w-[820px]" : undefined}
      >
        {isLoading ? (
          <p className="font-mono text-[11.5px] text-faint">Loading…</p>
        ) : error ? (
          <Placeholder
            title="Couldn’t load file"
            body={
              error instanceof Error
                ? error.message
                : "Unknown error reading this file."
            }
          />
        ) : data ? (
          <FileBody
            file={data}
            onSelectNode={onSelectNode}
            fileSet={fileSet}
            linkRepoFiles={linkRepoFiles}
          />
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
/** Stable empty fallback for `FileBody`'s `fileSet` prop (no tracked-file manifest available). */
const EMPTY_FILE_SET: Set<string> = new Set();
const MAX_HIGHLIGHTED_FILE_LINES = 500;

function contextNodeForLink(fromPath: string, href: string): string | null {
  // A site-absolute `/context/<bucket>/…` href already carries its own bucket, so it resolves against the
  // context root — NOT relative to `fromPath`. Delegate it to the href-based resolver.
  if (href.startsWith("/context/")) return contextConvoNodeForHref(href);
  const parts = fromPath.split("/");
  const bucket = parts[0];
  const prefix =
    bucket === "specs"
      ? "spec:"
      : bucket === "generated"
        ? "gen:"
        : bucket === "artifacts"
          ? "artifact:"
          : null;
  if (!prefix) return null;
  const stack = parts.slice(1, -1); // dir of the current file, within the bucket
  for (const seg of href.split(/[?#]/)[0].split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  if (stack.length === 0) return null;
  return prefix + stack.join("/");
}

function FileBody({
  file,
  onSelectNode,
  fileSet = EMPTY_FILE_SET,
  linkRepoFiles = false,
}: {
  file: ContextFileContent;
  onSelectNode?: (node: string) => void;
  /** The job worktree's tracked-file manifest — used to linkify a spec's inline-code file-path spans. */
  fileSet?: Set<string>;
  /** Opt-in for spec markdown only; generated/artifact markdown keeps ordinary inline code chips. */
  linkRepoFiles?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  if (file.content.trim() === "") {
    return (
      <p className="font-mono text-[11.5px] italic text-faint">
        This file is empty.
      </p>
    );
  }
  if (file.mime === "text/markdown") {
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
        resolveFileLink={
          linkRepoFiles && onSelectNode
            ? makeResolveFileLink(fileSet, pathname, searchParams, onSelectNode)
            : undefined
        }
      >
        {file.content}
      </Markdown>
    );
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-dim">
      {file.content}
    </pre>
  );
}

/** Builds a `data:` URL for a context file's inline content (base64 or utf8-encoded). */
function fileDataUrl(file: ContextFileContent): string {
  return file.encoding === "base64"
    ? `data:${file.mime};base64,${file.content}`
    : `data:${file.mime};utf8,${encodeURIComponent(file.content)}`;
}

/** Image artifact viewer. Renders full-bleed — the viewer fills the entire pane body below the top bar. */
function ImageFileBody({ file }: { file: ContextFileContent }) {
  return <ImageViewer src={fileDataUrl(file)} alt={file.name} />;
}

/**
 * Text-ish `application/*` mimes whose content is plain text worth copying. `text/*` is always copyable;
 * `image/*` is copied as a PNG bitmap. Anything else (zip, pdf, octet-stream, …) can't be copied — the copy
 * button hides itself for those.
 */
const COPYABLE_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
]);

function fileCopyKind(mime: string): "text" | "image" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || COPYABLE_APPLICATION_MIMES.has(mime))
    return "text";
  return null;
}

/** Re-encode any image data URL to a PNG blob via a canvas — browser clipboard image writes only accept PNG. */
async function imageDataUrlToPngBlob(dataUrl: string): Promise<Blob> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("Could not get a 2D canvas context for image copy.");
  ctx.drawImage(img, 0, 0);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Canvas produced no PNG blob.")),
      "image/png",
    ),
  );
}

/**
 * The file detail pane's working copy button, dropped into the top bar's copy slot. Copies text content for
 * text/markdown/code/JSON files and the image (as PNG) for images; renders nothing for a file whose type
 * can't be copied, so the copy action simply disappears for zips and other binaries.
 */
function FileCopyButton({ file }: { file: ContextFileContent | undefined }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const kind = file ? fileCopyKind(file.mime) : null;
  if (!file || !kind) return null;

  async function copy() {
    if (!file || !kind) return;
    try {
      if (kind === "image") {
        const pngBlob = await imageDataUrlToPngBlob(fileDataUrl(file));
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": pngBlob }),
        ]);
      } else {
        const text =
          file.encoding === "base64" ? atob(file.content) : file.content;
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }

  return (
    <TopBarButton
      title={copied ? "Copied" : kind === "image" ? "Copy image" : "Copy file"}
      onClick={copy}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </TopBarButton>
  );
}

/**
 * HTML artifact viewer. Renders the document full-bleed — the iframe fills the entire pane body below the
 * top bar — in a SANDBOXED iframe (`allow-scripts`, but NO `allow-same-origin` → opaque origin): its own
 * CSS/JS run so mockups render faithfully, but it can't read the session cookie, call the API as the
 * operator, or reach the parent DOM. The iframe loads from the path-based `context/raw` route so the
 * document's relative sub-resources (`style.css`, images) resolve.
 */
function HtmlFileBody({
  file,
  jobRef,
}: {
  file: ContextFileContent;
  jobRef: JobRef;
}) {
  return (
    <iframe
      src={contextRawUrl(jobRef, file.path)}
      title={file.name}
      sandbox="allow-scripts"
      className="h-full w-full flex-1 border-0 bg-white"
    />
  );
}

/** A `?node=` that no longer resolves (deleted file, re-planned thread/step). Placeholder styling — the
 *  designer will restyle/replace this. */
function NodeNotFound({
  node,
  onConversation,
}: {
  node: string;
  onConversation: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="text-[14px] font-semibold text-text">
        This node isn’t here anymore
      </p>
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-dim">
        The pane you linked to (
        <span className="font-mono text-[11.5px]">{node}</span>) is no longer
        part of this thread — it may have been removed or replaced when the plan
        changed.
      </p>
      <button
        type="button"
        onClick={onConversation}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md border px-3.5 py-2 text-[12px] font-medium text-accent"
        style={{
          background: "var(--accent-soft)",
          borderColor: "var(--accent-line)",
        }}
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
    (liveTurn
      ? indexLiveSubagents(liveTurn.blocks).summaryById.get(parentId)
      : undefined);
  const label = summary ? subagentLabel(summary.type) : "Subagent";
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          onClick={onBack}
          title="Back to base"
          className="flex items-center text-[17px] leading-none text-blue hover:opacity-80"
        >
          ‹
        </button>
        {base ? (
          <button
            type="button"
            onClick={onBack}
            className="flex min-w-0 items-center gap-1.5 hover:opacity-80"
          >
            <FileText size={12} className="shrink-0 text-blue" />
            <span className="max-w-[150px] truncate font-mono text-[10px] text-dim">
              {base}
            </span>
          </button>
        ) : null}
        <span className="text-[11px] font-semibold text-border-2">▸</span>
        <span
          className="grid h-[19px] w-[19px] shrink-0 place-items-center rounded-[5px] text-[10px]"
          style={{
            background: "color-mix(in srgb, var(--blue) 13%, transparent)",
            color: "var(--blue)",
          }}
        >
          ◈
        </span>
        <span className="truncate font-disp text-[11px] font-semibold text-text">
          {label}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-faint">
          sub-agent
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onBack}
          title="Close sub-agent"
          className="text-[15px] leading-none text-faint hover:text-text"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubagentView
          jobRef={jobRef}
          messages={messages}
          liveTurn={liveTurn ?? null}
          parentId={parentId}
        />
      </div>
    </div>
  );
}

/** A stacked repo-file view over the spec/plan pane — breadcrumb header (‹ / base crumb / ×, all Back) +
 *  a syntax-highlighted, line-number listing scrolled to (and highlighting) the referenced `:line`/`:range`. */
export function FilePane({
  jobRef,
  path,
  lines,
  base,
  onBack,
}: {
  jobRef: JobRef;
  path: string;
  lines: string | null;
  base: string | null;
  onBack: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <button
          type="button"
          onClick={onBack}
          title="Back"
          className="flex items-center text-[17px] leading-none text-blue hover:opacity-80"
        >
          ‹
        </button>
        {base ? (
          <button
            type="button"
            onClick={onBack}
            className="flex min-w-0 items-center gap-1.5 hover:opacity-80"
          >
            <FileText size={12} className="shrink-0 text-blue" />
            <span className="max-w-[150px] truncate font-mono text-[10px] text-dim">
              {base}
            </span>
          </button>
        ) : null}
        <span className="text-[11px] font-semibold text-border-2">▸</span>
        <FileText size={13} className="shrink-0 text-dim" />
        <span className="truncate font-mono text-[11px] font-semibold text-text">
          {name}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-faint">
          {lines ? `:${lines}` : "file"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onBack}
          title="Close"
          className="text-[15px] leading-none text-faint hover:text-text"
        >
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <RepoFileBody jobRef={jobRef} path={path} lines={lines} />
      </div>
    </div>
  );
}

function RepoFileBody({
  jobRef,
  path,
  lines,
}: {
  jobRef: JobRef;
  path: string;
  lines: string | null;
}) {
  const { data, isLoading, error } = useRepoFile(jobRef, path);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse "18" / "18-24" → the active line-number set + the first line to scroll to.
  const { activeNos, firstLine } = useMemo(() => {
    const empty = {
      activeNos: undefined as Set<number> | undefined,
      firstLine: null as number | null,
    };
    if (!lines) return empty;
    const m = /^(\d+)(?:-(\d+))?$/.exec(lines);
    if (!m) return empty;
    const start = Number(m[1]);
    if (!Number.isSafeInteger(start) || start < 1) return empty;
    const rawEnd = m[2] ? Number(m[2]) : start;
    const endCandidate =
      Number.isSafeInteger(rawEnd) && rawEnd >= start ? rawEnd : start;
    const end = Math.min(endCandidate, start + MAX_HIGHLIGHTED_FILE_LINES - 1);
    const set = new Set<number>();
    for (let n = start; n <= end; n++) set.add(n);
    return { activeNos: set, firstLine: start };
  }, [lines]);

  useEffect(() => {
    if (!data || firstLine == null) return;
    const el = containerRef.current?.querySelector(
      `[data-line="${firstLine}"]`,
    );
    el?.scrollIntoView({ block: "center" });
  }, [data, firstLine]);

  if (isLoading)
    return (
      <div className="px-8 py-7">
        <p className="font-mono text-[11.5px] text-faint">Loading…</p>
      </div>
    );
  if (error)
    return (
      <div className="px-8 py-7">
        <Placeholder
          title="Couldn’t load file"
          body={
            error instanceof Error
              ? error.message
              : "Unknown error reading this file."
          }
        />
      </div>
    );
  if (!data) return null;
  if (data.mime.startsWith("image/")) {
    const src =
      data.encoding === "base64"
        ? `data:${data.mime};base64,${data.content}`
        : `data:${data.mime};utf8,${encodeURIComponent(data.content)}`;
    return (
      <div className="h-full overflow-y-auto px-8 py-7">
        <ImageViewer src={src} alt={data.name} />
      </div>
    );
  }
  const lang = langFromPath(path);
  const rows = data.content
    .replace(/\n$/, "")
    .split("\n")
    .map((code, i) => ({ no: i + 1, code }));
  return (
    <div ref={containerRef} className="h-full overflow-hidden">
      <CodeListing
        rows={rows}
        lang={lang}
        activeNos={activeNos}
        maxHeight="100%"
        whole
        flush
      />
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
        <span className="font-mono text-[9px] tracking-[0.14em] text-faint">
          DETAIL
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-border-2 text-faint">
          <PanelRight size={18} strokeWidth={1.6} />
        </div>
        <p className="text-[14px] font-semibold text-text">Nothing selected</p>
        <p className="mt-1.5 max-w-xs text-[12.5px] leading-relaxed text-dim">
          Pick a file, thread, or step from the navigator and it opens here. The
          conversation stays pinned on the left.
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
      <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-dim">
        {body}
      </p>
    </div>
  );
}

function DocLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 font-mono text-[9px] tracking-[0.14em] text-faint">
      {children}
    </div>
  );
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
        color: "var(--green, #15803d)",
        background:
          "color-mix(in srgb, var(--green, #15803d) 12%, transparent)",
      }}
    >
      confirmed
    </span>
  ) : (
    <span
      className="whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.04em]"
      style={{
        color: "var(--amber, #b45309)",
        background:
          "color-mix(in srgb, var(--amber, #b45309) 12%, transparent)",
      }}
    >
      Atlas-authored
    </span>
  );
}
