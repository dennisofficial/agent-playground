"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  useGroupRef,
} from "react-resizable-panels";
import { useBreakpoint } from "@/lib/use-breakpoint";
import { Drawer } from "@/components/ui/drawer";
import { useAllJobs } from "@/lib/api/inbox";
import {
  useJobMessages,
  usePipeline,
  useJobContext,
  useDeleteJob,
  useRenameJob,
  useSetAutoApprove,
  useSay,
} from "@/lib/api/job-queries";
import { useJobEvents } from "@/lib/api/job-events";
import { MAIN_LANE } from "@/lib/api/job-stream";
import { toJobKind, toJobStatus } from "@/lib/api/status";
import { orgSwatch } from "@/lib/org-display";
import { ROUTES } from "@/lib/routes";
import { pipelineJob, type JobRef } from "@/lib/api/job-api";
import {
  APPROVE_ACTION_ID,
  SHIP_ACTION_ID,
  type JobKind,
  type JobStatus,
  type PipelineJob,
  type ThreadStatus,
  type WebApprovalCard,
} from "@/lib/api/types";
import { Navigator, type JobMeta } from "./navigator";
import { Conversation } from "./conversation";
import { MarkdownActionsProvider } from "./markdown";
import { PhaseView, EmptyPane, SubagentPane, FilePane } from "./step-view";
import { PersistentApprovalBar, PersistentShipBar } from "./spec-approval";
import { useSelectedNode } from "./use-selected-node";
import { ReviewCommentsProvider } from "./review-comments";
import { SelectionCommentPopover } from "./selection-comment-popover";
import { DeleteJobPrDialog } from "./delete-job-pr-dialog";

/**
 * The thread workspace — the navigator (pipeline / state panels) + the work column (Conversation or
 * Step). Resolves its own data from the org → repo → thread API. The shell's "needs you" dots come from
 * the server-owned thread-list fields (no longer fed from here); this just renders the open thread.
 */
export function JobWorkspace({ orgId, repoId, jobId }: JobRef) {
  const router = useRouter();
  const ref = useMemo<JobRef>(
    () => ({ orgId, repoId, jobId }),
    [orgId, repoId, jobId],
  );

  const { data: inbox } = useAllJobs();
  const { data: messages = [], isLoading: messagesLoading } =
    useJobMessages(ref);
  const { data: pipeline, isLoading: pipelineLoading } = usePipeline(ref);
  const { data: context, isLoading: contextLoading } = useJobContext(ref);
  const del = useDeleteJob(ref);
  const rename = useRenameJob(ref);
  const autoApprove = useSetAutoApprove(ref);
  useJobEvents(ref);

  // One send-into-this-thread action, shared by every `Markdown` in the workspace (conversation AND the
  // detail-pane spec viewer) — that's why a broken mermaid diagram's "send to Atlas" button appears in
  // both. `mutate` is referentially stable, so the context value doesn't churn.
  const sayMutate = useSay(ref).mutate;
  const markdownActions = useMemo(
    () => ({ sendToThread: (text: string) => sayMutate(text) }),
    [sayMutate],
  );

  // Two independent selections: `laneNode` (?lane=) drives the LEFT pane (a THREADS lane — Main or a build
  // thread/step); `detailNode` (?node=) drives the RIGHT pane (an OUTPUT / port / subagent / doc). A thread
  // switch navigates to a fresh clean URL with no query, so both reset — no reset effect needed.
  const {
    laneNode,
    detailNode,
    subNode,
    subLane,
    selectNode,
    replaceLane,
    openConversation,
    closeDetail,
    closeSub,
    fileNode,
    fileLines,
    closeFile,
  } = useSelectedNode();

  // Persist the conversation/detail split ratio across reloads (per-browser). `panelIds` lets the
  // library remember the layout even though the detail panel is only conditionally mounted.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "thread-work-split",
    panelIds: ["conversation", "detail"],
    storage: typeof window === "undefined" ? undefined : window.localStorage,
  });
  const groupRef = useGroupRef();

  // Responsive tiers. All four flags are `false` on the server and first client paint (desktop-first), so
  // "all false" MUST read as the xl/desktop case to avoid a wide-screen flash. `belowXl` → Detail becomes a
  // right drawer; `navAsDrawer` → Navigator becomes a left drawer (md and below).
  const { isMobile, isTablet, isDesktop } = useBreakpoint();
  const belowXl = isDesktop || isTablet || isMobile;
  const navAsDrawer = isTablet || isMobile;
  const detailSelected = Boolean(detailNode || subNode || fileNode);
  const detailDrawerOpen = belowXl && detailSelected;

  const [navOpen, setNavOpen] = useState(false);
  // The last detail node the operator opened — lets the trailing "Detail" toggle re-open it after the drawer
  // is dismissed (falls back to the plan doc when nothing has been opened yet).
  const lastDetail = useRef<string | null>(null);
  useEffect(() => {
    if (detailNode) lastDetail.current = detailNode;
  }, [detailNode]);
  useEffect(() => {
    if (!navAsDrawer) setNavOpen(false);
  }, [navAsDrawer]);
  // Close the nav drawer on ANY selection made from it: a lane switch (?lane=) OR a detail-node pick
  // (?node=, which leaves laneNode unchanged). Without detailNode here, tapping a spec/artifact/log/diff
  // row in the open left drawer would open the right detail drawer on top of it — two stacked drawers.
  useEffect(() => {
    setNavOpen(false);
  }, [laneNode, detailNode]);

  const openNav = () => setNavOpen(true);
  const openDetail = () => selectNode(lastDetail.current ?? "plan");

  const inboxThread = useMemo(
    () => inbox?.find((t) => t.id === jobId),
    [inbox, jobId],
  );
  const job = pipelineJob(pipeline);

  // Prefer the pipeline job; fall back to the sidebar feed (resolves earlier). null = genuinely unknown.
  const prState = job?.prState ?? inboxThread?.pr?.state ?? null;
  const prUrl = job?.prUrl ?? inboxThread?.pr?.url ?? null;
  const prNumber = job?.prNumber ?? null;
  const hasOpenPr = prState === "open" && Boolean(prUrl);
  // PR state is "known" once EITHER source has resolved; until then, block delete (don't leave-orphan).
  const prStateKnown = job != null || inboxThread != null;
  const [prDialogOpen, setPrDialogOpen] = useState(false);

  // Opening a job lands on the build lane that's currently running (the "builder thread") rather than always
  // on Main — you click a job to watch what it's doing. Decided ONCE per job open, the first time the
  // pipeline resolves: if a lane is already selected (deep link / in-place return) we respect it, and if
  // nothing is actively building we stay on Main. Marking `handled` on the first pipeline response (even the
  // pre-build `no_job` one) means a later plan-approval→build transition never yanks you off Main mid-read.
  const autoSelectedFor = useRef<string | null>(null);
  useEffect(() => {
    if (autoSelectedFor.current === jobId) return;
    if (!pipeline) return; // wait for the first pipeline response before deciding
    autoSelectedFor.current = jobId;
    if (laneNode) return; // an explicit / deep-linked lane wins
    const running = job ? runningLane(job) : null;
    if (running) replaceLane(running);
  }, [pipeline, job, jobId, laneNode, replaceLane]);

  const pipelineKind = job ? toJobKind(job.kind) : null;
  const kind: JobKind = inboxThread?.kind ?? pipelineKind ?? "feat";
  const status: JobStatus = job
    ? toJobStatus(job.status)
    : kind === "event"
      ? "triaging"
      : "planning";

  // The LAST plan-approval card in the log (kind `plan`/`direct`/undefined — never the ship-review card
  // or the brain's `amend` proposal, which are distinct gates with their own inline rendering). A POSITIVE
  // match so a new gate kind can't accidentally drive the plan navigator. Also feeds the "plan" doc viewer.
  const approvalCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (
        card?.type === "approval_card" &&
        (card.kind === "plan" || card.kind === "direct" || card.kind == null)
      )
        return card;
    }
    return null;
  }, [messages]);

  // The LAST ship-review card in the log (kind `ship`) — posted once the build + master review finish.
  const shipCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (card?.type === "approval_card" && card.kind === "ship") return card;
    }
    return null;
  }, [messages]);

  // The async spec-approval surfaces (navigator callout + persistent detail-pane bar) render only while
  // the thread awaits approval AND we have a valid approve `value` to POST. The backend value is just
  // `{ jobId, decisionRecordId? }` (see `approval-blocks.ts`): prefer the inline approval card's verbatim
  // value when one is in the log, but reconstruct it from the pipeline otherwise — an awaiting thread
  // always carries its job + decision record on the pipeline even when no `approval_card` message exists.
  const approveValue = useMemo<string>(() => {
    const fromCard =
      approvalCard?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)
        ?.value ?? approvalCard?.actions[0]?.value;
    if (fromCard) return fromCard;
    if (job && status === "awaiting_approval") {
      return JSON.stringify({
        jobId: job.jobId,
        ...(job.decisionRecordId
          ? { decisionRecordId: job.decisionRecordId }
          : {}),
      });
    }
    return "";
  }, [approvalCard, job, status]);
  const awaitingApproval =
    status === "awaiting_approval" && Boolean(approveValue);
  // A direct build (fast path) parks at the same gate but carries `kind: 'direct'` — flip the approve CTA
  // copy to "Approve Direct Build" so the operator can tell the fast path from a full plan at a glance.
  const isDirectApproval = approvalCard?.kind === "direct";

  // The ship-review gate's surfaces render the same way, off the ship card's own `{ jobId }` value —
  // reconstructed from the job alone when no `approval_card` message is in the log yet (a job can reach
  // `awaiting_ship_review` before that durable card lands).
  const shipValue = useMemo<string>(() => {
    const fromCard = shipCard?.actions.find(
      (a) => a.actionId === SHIP_ACTION_ID,
    )?.value;
    if (fromCard) return fromCard;
    if (job && status === "awaiting_ship_review") {
      return JSON.stringify({ jobId: job.jobId });
    }
    return "";
  }, [shipCard, job, status]);
  const awaitingShip = status === "awaiting_ship_review" && Boolean(shipValue);
  const specCount = context?.specs?.length ?? 0;
  const stepCount =
    job?.threads.reduce((n, t) => n + (t.steps?.length ?? 0), 0) ?? 0;

  const meta: JobMeta = {
    title: inboxThread?.title ?? job?.title ?? "Thread",
    kind,
    status,
    orgName: inboxThread?.org.name ?? "Organization",
    orgColor: orgSwatch(),
    repoName: inboxThread?.repo.name ?? repoId,
    // Prefer the full pipeline (fresher, and the only source once threads/builds exist); fall back to the
    // inbox row for a job still in `no_job` (pre-build `open`/chat) — the most common time to want the
    // parent link. `job?.createdBy ?? inboxThread?.createdBy` would wrongly fall through to the inbox row
    // whenever the pipeline's own value is null, so gate on `job` existing at all instead.
    createdBy: job ? (job.createdBy ?? null) : (inboxThread?.createdBy ?? null),
    blockedBy: job ? (job.blockedBy ?? []) : (inboxThread?.blockedBy ?? []),
    blockedSeedMessage: job
      ? (job.blockedSeedMessage ?? null)
      : (inboxThread?.blockedSeedMessage ?? null),
  };

  const onConversation = openConversation;
  const onSelectNode = selectNode;
  const onOpenPlan = () => selectNode("plan");
  const onRename = (title: string) => rename.mutate(title);
  const runDelete = (prAction: "close" | "leave") =>
    del.mutate(prAction, {
      onSuccess: () => {
        setPrDialogOpen(false);
        router.push(ROUTES.workspace());
      },
    });

  const onDelete = () => {
    if (!prStateKnown) return; // safety: never delete before we know whether a PR is open (button is disabled too)
    if (hasOpenPr) setPrDialogOpen(true);
    else runDelete("leave"); // confirmed no open PR → today's behavior
  };

  // The navigator, authored once and rendered either inline (xl/lg rail) or inside the left drawer (md/below).
  const navigatorPane = (inDrawer: boolean) => (
    <Navigator
      meta={meta}
      pipeline={pipeline}
      context={context}
      contextLoading={contextLoading}
      laneNode={laneNode}
      detailNode={detailNode}
      jobRef={ref}
      approveValue={awaitingApproval ? approveValue : ""}
      shipValue={awaitingShip ? shipValue : ""}
      previewRequestedAt={shipCard?.previewRequestedAt ?? null}
      directBuild={isDirectApproval}
      onConversation={onConversation}
      onSelectNode={onSelectNode}
      onRename={onRename}
      onDelete={onDelete}
      onSetAutoApprove={(mode) => autoApprove.mutate(mode)}
      deleting={del.isPending}
      hasOpenPr={hasOpenPr}
      deleteReady={prStateKnown}
      inDrawer={inDrawer}
    />
  );

  // The LEFT work pane — the Main brain conversation by default; a selected THREADS lane replaces it with that
  // lane's transcript. Authored once so the desktop Panel and the narrow single-pane share it; the two toggle
  // callbacks are the only thing that changes across tiers (undefined = no top-bar button, i.e. desktop).
  const workPane = (onOpenNav?: () => void, onOpenDetail?: () => void) =>
    laneNode ? (
      <PhaseView
        jobRef={ref}
        pipeline={pipeline}
        pipelineLoading={pipelineLoading}
        messages={messages}
        approvalCard={approvalCard}
        selectedNode={laneNode}
        onConversation={openConversation}
        onSelectNode={(node) => selectNode(node, { push: true })}
        onOpenNav={onOpenNav}
        onOpenDetail={onOpenDetail}
        blockedBy={meta.blockedBy}
      />
    ) : (
      <Conversation
        jobRef={ref}
        messages={messages}
        isLoading={messagesLoading}
        live={status === "running" || status === "plan_review"}
        blocked={status === "blocked"}
        blockedBy={meta.blockedBy}
        blockedSeedMessage={meta.blockedSeedMessage}
        mainDefaultFooter={pipeline?.mainDefaultFooter}
        onOpenPlan={onOpenPlan}
        onSelectNode={(node) => selectNode(node, { push: true })}
        onOpenNav={onOpenNav}
        onOpenDetail={onOpenDetail}
      />
    );

  // The detail-pane content — the same node body whether it fills the desktop Panel or the right drawer.
  const detailBody = (onBack?: () => void) => (
    <div
      data-testid="detail-pane"
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {subNode ? (
        // A sub-agent stacked on top of the right pane — a second-level page with a breadcrumb back to
        // the base detail node (which stays selected in the navigator underneath).
        <SubagentPane
          jobRef={ref}
          messages={messages}
          parentId={subNode}
          lane={subLane ?? MAIN_LANE}
          base={detailNode ? baseCrumbLabel(detailNode) : null}
          onBack={closeSub}
        />
      ) : detailNode ? (
        <PhaseView
          jobRef={ref}
          pipeline={pipeline}
          pipelineLoading={pipelineLoading}
          messages={messages}
          approvalCard={approvalCard}
          selectedNode={detailNode}
          onConversation={closeDetail}
          onSelectNode={(node) => selectNode(node, { push: true })}
          onBack={onBack}
          blockedBy={meta.blockedBy}
          tracksComments
        />
      ) : (
        <EmptyPane />
      )}
      {fileNode ? (
        <div className="absolute inset-0 z-10 bg-surface">
          <FilePane
            jobRef={ref}
            path={fileNode}
            lines={fileLines}
            base={detailNode ? baseCrumbLabel(detailNode) : null}
            onBack={closeFile}
          />
        </div>
      ) : null}
    </div>
  );

  // The persistent approval / ship gate — pins to the base of whichever surface hosts the detail content.
  // Shown ONLY on mobile: that's the sole tier where the job sidebar and the navigator's approve/ship
  // buttons collapse into a drawer, so the footer is the reachable gate. On md+ the navigator's inline
  // buttons and the conversation's approval card cover it, and the footer was redundant there.
  const footerBar = !isMobile ? null : awaitingApproval ? (
    <PersistentApprovalBar
      jobRef={ref}
      value={approveValue}
      specCount={specCount}
      stepCount={stepCount}
      directBuild={isDirectApproval}
    />
  ) : awaitingShip ? (
    <PersistentShipBar jobRef={ref} value={shipValue} />
  ) : null;

  return (
    <MarkdownActionsProvider value={markdownActions}>
      <ReviewCommentsProvider jobRef={ref}>
        <div className="flex h-full min-h-0">
          {navAsDrawer ? null : navigatorPane(false)}
          {!belowXl ? (
            // DESKTOP (xl) — the unchanged horizontal split: the conversation is ALWAYS pinned on the left and
            // the detail pane is a CONSTANT container on the right (never closes). The divider is a draggable
            // resize handle (react-resizable-panels); the ratio is persisted. Mounts ONLY at xl so the library
            // never runs below it.
            <Group
              orientation="horizontal"
              id="thread-work-split"
              groupRef={groupRef}
              defaultLayout={defaultLayout}
              onLayoutChanged={onLayoutChanged}
              className="min-w-0 flex-1 bg-surface"
            >
              <Panel
                id="conversation"
                minSize="28%"
                className="flex min-w-0 flex-col"
              >
                {workPane(undefined, undefined)}
              </Panel>
              {/* A 1px divider line, NOT a 6px reserved strip — so both panes (and the detail-pane footers like
              the approval bar) sit flush against it. The resizable hit target is widened by the library's
              `resizeTargetMinimumSize` (10px mouse / 20px touch), so dragging stays easy despite the thin line. */}
              {/* `Separator` always stamps its own `data-testid`/`id` from this `id` prop (falling back to a
              generated one) — passing it directly, rather than `data-testid`, is the only way to get a
              stable, library-respected test hook here. */}
              <Separator
                id="pane-resize-handle"
                disableDoubleClick
                onDoubleClick={() =>
                  groupRef.current?.setLayout({ conversation: 50, detail: 50 })
                }
                title="Drag to resize · double-click to center"
                className="relative w-px bg-border outline-none transition-colors hover:bg-border-2 active:bg-text/50"
              />
              <Panel
                id="detail"
                defaultSize="50%"
                minSize="32%"
                className="flex min-w-0 flex-col"
              >
                {detailBody()}
                {footerBar}
              </Panel>
            </Group>
          ) : (
            <div className="relative flex min-w-0 flex-1 flex-col bg-surface">
              {workPane(
                navAsDrawer ? openNav : undefined,
                !detailDrawerOpen ? openDetail : undefined,
              )}
              {/* The gate pins over the conversation only while the detail drawer is closed — when the drawer
              hosts the detail content it carries the gate in its own footer, so it's always reachable. */}
              {!detailDrawerOpen ? footerBar : null}
            </div>
          )}
          {navAsDrawer ? (
            <Drawer
              side="left"
              open={navOpen}
              onClose={() => setNavOpen(false)}
              label="Navigator"
            >
              {navigatorPane(true)}
            </Drawer>
          ) : null}
          {belowXl ? (
            <Drawer
              side="right"
              open={detailDrawerOpen}
              onClose={closeDetail}
              label="Detail"
              widthClass={
                isMobile ? "w-full max-w-none" : "w-[min(720px,85vw)]"
              }
            >
              <div className="flex h-full min-h-0 flex-col bg-surface">
                {detailBody(closeDetail)}
                {footerBar}
              </div>
            </Drawer>
          ) : null}
        </div>
        <SelectionCommentPopover />
        {prDialogOpen ? (
          <DeleteJobPrDialog
            prNumber={prNumber}
            pending={del.isPending}
            error={del.error as Error | null}
            onChoose={runDelete}
            onClose={() => {
              setPrDialogOpen(false);
              del.reset();
            }}
          />
        ) : null}
      </ReviewCommentsProvider>
    </MarkdownActionsProvider>
  );
}

/** The STEP values that count as "currently running" for the open-a-job default — a lane doing active work
 *  (executing / auto-fixing / reviewing / generating its just-in-time plan). `pending` (queued) and the
 *  terminal `done` are excluded; a lane halted with a `failed`/`incomplete` condition is filtered out at the
 *  call site (a `paused` lane still counts — it's parked mid-build, waiting on you). */
const RUNNING_THREAD_STATUSES: ReadonlySet<ThreadStatus> =
  new Set<ThreadStatus>(["planning", "reviewing", "executing", "auto_fixing"]);

/** The `?lane=` id of the build lane to open when a job is first opened, or `null` to stay on Main. Picks the
 *  highest-ordinal running thread (the current build frontier in a sequential run); the id IS the lane token
 *  (a build thread is a bare-id node — see `node-registry.threadNode`). */
function runningLane(job: PipelineJob): string | null {
  let pick: PipelineJob["threads"][number] | null = null;
  for (const t of job.threads) {
    if (!RUNNING_THREAD_STATUSES.has(t.status)) continue;
    if (t.condition === "failed" || t.condition === "incomplete") continue; // terminal halt — not running
    if (!pick || t.ordinal > pick.ordinal) pick = t;
  }
  return pick?.id ?? null;
}

/** Short label for the base detail node, shown in a stacked sub-agent's breadcrumb (`‹ 02-webhooks.md ▸ …`).
 *  Detail nodes are files/docs/ports (never bare thread ids — those open in the left pane), so no job lookup
 *  is needed. */
function baseCrumbLabel(node: string): string {
  if (node === "diff") return "Diff";
  if (node === "plan") return "Plan";
  if (node === "decision") return "Decision record";
  if (node === "tickets") return "Tickets raised";
  if (node === "created") return "Created jobs";
  if (node === "blocked-by") return "Blocked by";
  const file = /^(?:spec|gen|artifact):(.+)$/.exec(node);
  if (file) return file[1].split("/").pop() ?? file[1];
  return node;
}
