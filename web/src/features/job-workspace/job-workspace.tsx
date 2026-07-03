'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from 'react-resizable-panels';
import { useAllJobs } from '@/lib/api/inbox';
import { useJobMessages, usePipeline, useJobContext, useDeleteJob, useRenameJob, useSay } from '@/lib/api/job-queries';
import { useJobEvents } from '@/lib/api/job-events';
import { MAIN_LANE } from '@/lib/api/job-stream';
import { toJobStatus } from '@/lib/api/status';
import { orgSwatch } from '@/lib/org-display';
import { ROUTES } from '@/lib/routes';
import { pipelineJob, type JobRef } from '@/lib/api/job-api';
import { APPROVE_ACTION_ID, type JobKind, type JobStatus, type WebApprovalCard } from '@/lib/api/types';
import { Navigator, type JobMeta } from './navigator';
import { Conversation } from './conversation';
import { MarkdownActionsProvider } from './markdown';
import { PhaseView, EmptyPane, SubagentPane } from './step-view';
import { PersistentApprovalBar } from './spec-approval';
import { useSelectedNode } from './use-selected-node';
import { ReviewCommentsProvider } from './review-comments';
import { SelectionCommentPopover } from './selection-comment-popover';

/**
 * The thread workspace — the navigator (pipeline / state panels) + the work column (Conversation or
 * Step). Resolves its own data from the org → repo → thread API. The shell's "needs you" dots come from
 * the server-owned thread-list fields (no longer fed from here); this just renders the open thread.
 */
export function JobWorkspace({ orgId, repoId, jobId }: JobRef) {
  const router = useRouter();
  const ref = useMemo<JobRef>(() => ({ orgId, repoId, jobId }), [orgId, repoId, jobId]);

  const { data: inbox } = useAllJobs();
  const { data: messages = [], isLoading: messagesLoading } = useJobMessages(ref);
  const { data: pipeline, isLoading: pipelineLoading } = usePipeline(ref);
  const { data: context, isLoading: contextLoading } = useJobContext(ref);
  const del = useDeleteJob(ref);
  const rename = useRenameJob(ref);
  useJobEvents(ref);

  // One send-into-this-thread action, shared by every `Markdown` in the workspace (conversation AND the
  // detail-pane spec viewer) — that's why a broken mermaid diagram's "send to Atlas" button appears in
  // both. `mutate` is referentially stable, so the context value doesn't churn.
  const sayMutate = useSay(ref).mutate;
  const markdownActions = useMemo(() => ({ sendToThread: (text: string) => sayMutate(text) }), [sayMutate]);

  // Two independent selections: `laneNode` (?lane=) drives the LEFT pane (a THREADS lane — Main or a build
  // thread/step); `detailNode` (?node=) drives the RIGHT pane (an OUTPUT / port / subagent / doc). A thread
  // switch navigates to a fresh clean URL with no query, so both reset — no reset effect needed.
  const { laneNode, detailNode, subNode, subLane, selectNode, openConversation, closeDetail, closeSub } =
    useSelectedNode();

  // Persist the conversation/detail split ratio across reloads (per-browser). `panelIds` lets the
  // library remember the layout even though the detail panel is only conditionally mounted.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'thread-work-split',
    panelIds: ['conversation', 'detail'],
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  });
  const groupRef = useGroupRef();

  const inboxThread = useMemo(() => inbox?.find((t) => t.id === jobId), [inbox, jobId]);
  const job = pipelineJob(pipeline);

  const kind: JobKind = inboxThread?.kind ?? 'feat';
  const status: JobStatus = job
    ? toJobStatus(job.status)
    : kind === 'event'
      ? 'triaging'
      : 'planning';

  const approvalCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (card?.type === 'approval_card') return card;
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
      approvalCard?.actions.find((a) => a.actionId === APPROVE_ACTION_ID)?.value ?? approvalCard?.actions[0]?.value;
    if (fromCard) return fromCard;
    if (job && status === 'awaiting_approval') {
      return JSON.stringify({
        jobId: job.jobId,
        ...(job.decisionRecordId ? { decisionRecordId: job.decisionRecordId } : {}),
      });
    }
    return '';
  }, [approvalCard, job, status]);
  const awaitingApproval = status === 'awaiting_approval' && Boolean(approveValue);
  const specCount = context?.specs?.length ?? 0;
  const stepCount = job?.threads.reduce((n, t) => n + (t.steps?.length ?? 0), 0) ?? 0;

  const meta: JobMeta = {
    title: inboxThread?.title ?? job?.title ?? 'Thread',
    kind,
    status,
    orgName: inboxThread?.org.name ?? 'Organization',
    orgColor: orgSwatch(),
    repoName: inboxThread?.repo.name ?? repoId,
  };

  const onConversation = openConversation;
  const onSelectNode = selectNode;
  const onOpenPlan = () => selectNode('plan');
  const onRename = (title: string) => rename.mutate(title);
  const onDelete = () =>
    del.mutate(undefined, {
      onSuccess: () => {
        router.push(ROUTES.workspace());
      },
    });

  return (
    <MarkdownActionsProvider value={markdownActions}>
    <ReviewCommentsProvider>
    <div className="flex h-full min-h-0">
      <Navigator
        meta={meta}
        pipeline={pipeline}
        context={context}
        contextLoading={contextLoading}
        laneNode={laneNode}
        detailNode={detailNode}
        jobRef={ref}
        approveValue={awaitingApproval ? approveValue : ''}
        onConversation={onConversation}
        onSelectNode={onSelectNode}
        onRename={onRename}
        onDelete={onDelete}
        deleting={del.isPending}
      />
      {/* Work column — a horizontal split: the conversation is ALWAYS pinned on the left and the detail
          pane is a CONSTANT container on the right (never closes). Selecting a navigator node fills it;
          with nothing selected it shows an empty state. The divider is a draggable resize handle
          (react-resizable-panels); the ratio is persisted. */}
      <Group
        orientation="horizontal"
        id="thread-work-split"
        groupRef={groupRef}
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="min-w-0 flex-1 bg-surface"
      >
        {/* LEFT pane — the Main brain conversation by default; a selected THREADS lane (build thread/step)
            replaces it with that lane's transcript. */}
        <Panel id="conversation" minSize="28%" className="flex min-w-0 flex-col">
          {laneNode ? (
            <PhaseView
              jobRef={ref}
              pipeline={pipeline}
              pipelineLoading={pipelineLoading}
              messages={messages}
              approvalCard={approvalCard}
              selectedNode={laneNode}
              onConversation={openConversation}
              onSelectNode={(node) => selectNode(node, { push: true })}
            />
          ) : (
            <Conversation
              jobRef={ref}
              messages={messages}
              isLoading={messagesLoading}
              live={status === 'running' || status === 'plan_review'}
              onOpenPlan={onOpenPlan}
              onSelectNode={(node) => selectNode(node, { push: true })}
            />
          )}
        </Panel>
        {/* A 1px divider line, NOT a 6px reserved strip — so both panes (and the detail-pane footers like
            the approval bar) sit flush against it. The resizable hit target is widened by the library's
            `resizeTargetMinimumSize` (10px mouse / 20px touch), so dragging stays easy despite the thin line. */}
        <Separator
          disableDoubleClick
          onDoubleClick={() => groupRef.current?.setLayout({ conversation: 50, detail: 50 })}
          title="Drag to resize · double-click to center"
          className="relative w-px bg-border outline-none transition-colors hover:bg-border-2 active:bg-text/50"
        />
        <Panel id="detail" defaultSize="50%" minSize="32%" className="flex min-w-0 flex-col">
          {/* The detail pane content fills the column; the persistent approval bar (when awaiting) pins to
              its base as a `flex:none` footer — present no matter what the pane is showing. */}
          <div className="flex min-h-0 flex-1 flex-col">
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
                tracksComments
              />
            ) : (
              <EmptyPane />
            )}
          </div>
          {awaitingApproval ? (
            <PersistentApprovalBar jobRef={ref} value={approveValue} specCount={specCount} stepCount={stepCount} />
          ) : null}
        </Panel>
      </Group>
    </div>
    <SelectionCommentPopover />
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
  const file = /^(?:spec|gen|artifact):(.+)$/.exec(node);
  if (file) return file[1].split('/').pop() ?? file[1];
  if (node.startsWith('port:')) return node.slice('port:'.length);
  return node;
}
