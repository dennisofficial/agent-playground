'use client';

import { Drawer } from '@/components/ui/drawer';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { useAllJobs } from '@/lib/api/inbox';
import type { JobRef } from '@/lib/api/job-api';
import { useJobEvents } from '@/lib/api/job-events';
import {
  useDeleteJob,
  useJobContext,
  useJobMessages,
  useMessage,
  usePipeline,
  useRenameJob,
  useSetAutoApprove,
  useSetAutoMerge,
} from '@/lib/api/job-queries';
import { MAIN_LANE } from '@/lib/api/job-stream';
import { APPROVE_ACTION_ID, SHIP_ACTION_ID, type WebApprovalCard } from '@/lib/api/types';
import { orgSwatch } from '@/utils/org-display';
import { EJobKind, EJobStatus } from '@workspace/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from 'react-resizable-panels';
import { Conversation } from './components/conversation/conversation';
import { DeleteJobPrDialog } from './components/chrome/delete-job-pr-dialog';
import { useSelectedNode } from './hooks/use-selected-node';
import { MarkdownActionsProvider } from './components/conversation/markdown';
import { Navigator, type JobMeta } from './components/navigator/navigator';
import {
  activeJob,
  jobBlockedBy,
  jobBlockedSeedMessage,
  jobCreatedBy,
  jobDecisionRecordId,
  jobPrNumber,
  jobPrState,
  jobPrUrl,
  mainDefaultFooter,
} from './lib/pipeline-selectors';
import { ReviewCommentsProvider } from './components/review/review-comments';
import { SelectionCommentPopover } from './components/review/selection-comment-popover';
import { PersistentApprovalBar, PersistentShipBar } from './spec-approval';
import { EmptyPane, FilePane, PhaseView, SubagentPane } from './components/panes/step-view';

/**
 * The thread workspace — the navigator (pipeline / state panels) + the work column (Conversation or
 * Step). Resolves its own data from the org → repo → thread API. The shell's "needs you" dots come from
 * the server-owned thread-list fields (no longer fed from here); this just renders the open thread.
 */
export function JobWorkspace({ orgId, repoId, jobId }: JobRef) {
  const ref = useMemo<JobRef>(() => ({ orgId, repoId, jobId }), [orgId, repoId, jobId]);

  const { data: inbox } = useAllJobs();
  const { data: messages = [], isLoading: messagesLoading } = useJobMessages(ref);
  const { data: pipeline, isLoading: pipelineLoading } = usePipeline(ref);
  const { data: context, isLoading: contextLoading } = useJobContext(ref);
  const del = useDeleteJob(ref);
  const rename = useRenameJob(ref);
  const autoApprove = useSetAutoApprove(ref);
  const autoMerge = useSetAutoMerge(ref);
  useJobEvents(ref);

  // One send-into-this-thread action, shared by every `Markdown` in the workspace (conversation AND the
  // detail-pane spec viewer) — that's why a broken mermaid diagram's "send to Atlas" button appears in
  // both. `mutate` is referentially stable, so the context value doesn't churn.
  const sendMessage = useMessage(ref).mutate;
  const markdownActions = useMemo(
    () => ({
      sendToThread: (text: string) => sendMessage({ messages: [{ type: 'user', text }] }),
    }),
    [sendMessage],
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
    id: 'thread-work-split',
    panelIds: ['conversation', 'detail'],
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
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
  const openDetail = () => selectNode(lastDetail.current ?? 'plan');

  const inboxThread = useMemo(() => inbox?.find((t) => t.id === jobId), [inbox, jobId]);
  const job = activeJob(pipeline);

  // Prefer the pipeline job; fall back to the sidebar feed (resolves earlier). null = genuinely unknown.
  // TODO(backend): JobView doesn't carry PR fields yet (`jobPr*` return null), so the inbox feed is the
  // only PR source until the read model emits them.
  const prState = jobPrState(job) ?? inboxThread?.pr?.state ?? null;
  const prUrl = jobPrUrl(job) ?? inboxThread?.pr?.url ?? null;
  const prNumber = jobPrNumber(job) ?? null;
  const hasOpenPr = prState === 'open' && Boolean(prUrl);
  // PR state is "known" once EITHER source has resolved; until then, block delete (don't leave-orphan).
  const prStateKnown = job != null || inboxThread != null;
  const [prDialogOpen, setPrDialogOpen] = useState(false);

  const pipelineKind = job?.kind;
  const kind: EJobKind = inboxThread?.kind ?? pipelineKind ?? EJobKind.FEATURE;
  const status: EJobStatus = job ? job.status : EJobStatus.PLANNING;

  // The LAST plan-approval card in the log (kind `plan`/`direct`/undefined — never the ship-review card
  // or the brain's `amend` proposal, which are distinct gates with their own inline rendering). A POSITIVE
  // match so a new gate kind can't accidentally drive the plan navigator. Also feeds the "plan" doc viewer.
  const approvalCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (
        card?.type === 'approval_card' &&
        (card.kind === 'plan' || card.kind === 'direct' || card.kind == null)
      )
        return card;
    }
    return null;
  }, [messages]);

  // The LAST ship-review card in the log (kind `ship`) — posted once the build + master review finish.
  const shipCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (card?.type === 'approval_card' && card.kind === 'ship') return card;
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
      approvalCard?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ??
      approvalCard?.actions[0]?.value;
    if (fromCard) return fromCard;
    if (job && status === 'awaiting_approval') {
      const decisionRecordId = jobDecisionRecordId(job);
      return JSON.stringify({
        jobId: job.id,
        ...(decisionRecordId ? { decisionRecordId } : {}),
      });
    }
    return '';
  }, [approvalCard, job, status]);
  const awaitingApproval = status === 'awaiting_approval' && Boolean(approveValue);
  // A direct build (fast path) parks at the same gate but carries `kind: 'direct'` — flip the approve CTA
  // copy to "Approve Direct Build" so the operator can tell the fast path from a full plan at a glance.
  const isDirectApproval = approvalCard?.kind === 'direct';

  // The ship-review gate's surfaces render the same way, off the ship card's own `{ jobId }` value —
  // reconstructed from the job alone when no `approval_card` message is in the log yet (a job can reach
  // `awaiting_ship_review` before that durable card lands).
  const shipValue = useMemo<string>(() => {
    const fromCard = shipCard?.actions.find((a) => a.actionId === SHIP_ACTION_ID)?.value;
    if (fromCard) return fromCard;
    if (job && status === 'awaiting_ship_review') {
      return JSON.stringify({ jobId: job.id });
    }
    return '';
  }, [shipCard, job, status]);
  const awaitingShip = status === 'awaiting_ship_review' && Boolean(shipValue);
  const specCount = context?.specs?.length ?? 0;
  // Plan-time size preview: a build thread group's `tasks` fold from the SDK's TaskCreate/TaskUpdate calls
  // made DURING execution, so they're always empty at the pre-build approval gate — count the plan's
  // proposed threads instead (the same list `PlanDoc` renders as "Sections"/"Changes"), which IS known at
  // approval time.
  const stepCount = approvalCard?.threads.length ?? 0;
  // Main's transcript is the planning thread group's own thread (undefined pre-plan, where the single brain
  // thread needs no scoping) — see `Conversation`'s `mainThreadId`.
  const mainThreadId = job?.threadGroups.find((s) => s.kind === 'planning')?.threads[0]?.id;

  const meta: JobMeta = {
    title: inboxThread?.title ?? job?.title ?? 'Thread',
    kind,
    status,
    orgName: inboxThread?.org.name ?? 'Organization',
    orgColor: orgSwatch(),
    repoName: inboxThread?.repo.name ?? repoId,
    // Prefer the full pipeline (fresher, and the only source once threads/builds exist); fall back to the
    // inbox row for a job still in `no_job` (pre-build `open`/chat) — the most common time to want the
    // parent link. `job?.createdBy ?? inboxThread?.createdBy` would wrongly fall through to the inbox row
    // whenever the pipeline's own value is null, so gate on `job` existing at all instead.
    createdBy: job ? jobCreatedBy(job) : (inboxThread?.createdBy ?? null),
    blockedBy: job ? jobBlockedBy(job) : (inboxThread?.blockedBy ?? []),
    blockedSeedMessage: job
      ? jobBlockedSeedMessage(job)
      : (inboxThread?.blockedSeedMessage ?? null),
  };

  const onConversation = openConversation;
  const onSelectNode = selectNode;
  const onOpenPlan = () => selectNode('plan');
  const onRename = (title: string) => rename.mutate(title);
  // Archiving is terminal but the job stays put — the operator remains on this (now read-only) page rather
  // than being navigated away, so there's no `router.push` here.
  const runDelete = (prAction: 'close' | 'leave') =>
    del.mutate(prAction, {
      onSuccess: () => setPrDialogOpen(false),
    });

  const onDelete = () => {
    if (!prStateKnown) return; // safety: never delete before we know whether a PR is open (button is disabled too)
    if (hasOpenPr) setPrDialogOpen(true);
    else runDelete('leave'); // confirmed no open PR → today's behavior
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
      approveValue={awaitingApproval ? approveValue : ''}
      shipValue={awaitingShip ? shipValue : ''}
      previewRequestedAt={shipCard?.previewRequestedAt ?? null}
      directBuild={isDirectApproval}
      onConversation={onConversation}
      onSelectNode={onSelectNode}
      onRename={onRename}
      onDelete={onDelete}
      onSetAutoApprove={(mode) => autoApprove.mutate(mode)}
      onSetAutoMerge={(body) => autoMerge.mutate(body)}
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
        live={status === 'running' || status === 'plan_review'}
        blocked={status === 'blocked'}
        archived={status === 'archived'}
        blockedBy={meta.blockedBy}
        blockedSeedMessage={meta.blockedSeedMessage}
        mainThreadId={mainThreadId}
        mainDefaultFooter={mainDefaultFooter(pipeline)}
        onOpenPlan={onOpenPlan}
        onSelectNode={(node) => selectNode(node, { push: true })}
        onOpenNav={onOpenNav}
        onOpenDetail={onOpenDetail}
      />
    );

  // The detail-pane content — the same node body whether it fills the desktop Panel or the right drawer.
  const detailBody = (onBack?: () => void) => (
    <div data-testid="detail-pane" className="relative flex min-h-0 flex-1 flex-col">
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
              <Panel id="conversation" minSize="28%" className="flex min-w-0 flex-col">
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
                onDoubleClick={() => groupRef.current?.setLayout({ conversation: 50, detail: 50 })}
                title="Drag to resize · double-click to center"
                className="relative w-px bg-border outline-none transition-colors hover:bg-border-2 active:bg-text/50"
              />
              <Panel id="detail" defaultSize="50%" minSize="32%" className="flex min-w-0 flex-col">
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
            <Drawer side="left" open={navOpen} onClose={() => setNavOpen(false)} label="Navigator">
              {navigatorPane(true)}
            </Drawer>
          ) : null}
          {belowXl ? (
            <Drawer
              side="right"
              open={detailDrawerOpen}
              onClose={closeDetail}
              label="Detail"
              widthClass={isMobile ? 'w-full max-w-none' : 'w-[min(720px,85vw)]'}
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

/** Short label for the base detail node, shown in a stacked sub-agent's breadcrumb (`‹ 02-webhooks.md ▸ …`).
 *  Detail nodes are files/docs/ports (never bare thread ids — those open in the left pane), so no job lookup
 *  is needed. */
function baseCrumbLabel(node: string): string {
  if (node === 'diff') return 'Diff';
  if (node === 'plan') return 'Plan';
  if (node === 'decision') return 'Decision record';
  if (node === 'created') return 'Created jobs';
  if (node === 'blocked-by') return 'Blocked by';
  const file = /^(?:spec|gen|artifact):(.+)$/.exec(node);
  if (file) return file[1].split('/').pop() ?? file[1];
  return node;
}
