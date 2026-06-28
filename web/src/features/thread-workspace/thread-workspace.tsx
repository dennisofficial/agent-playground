'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from 'react-resizable-panels';
import { useAllThreads } from '@/lib/api/inbox';
import { useThreadMessages, usePipeline, useThreadContext, useDeleteThread, useRenameThread, useSay } from '@/lib/api/thread-queries';
import { useThreadEvents } from '@/lib/api/thread-events';
import { toThreadStatus } from '@/lib/api/status';
import { orgSwatch } from '@/lib/org-display';
import { ROUTES } from '@/lib/routes';
import { pipelineJob, type ThreadRef } from '@/lib/api/thread-api';
import type { ThreadKind, ThreadStatus, WebApprovalCard } from '@/lib/api/types';
import { Navigator, type ThreadMeta } from './navigator';
import { Conversation } from './conversation';
import { MarkdownActionsProvider } from './markdown';
import { PhaseView, EmptyPane } from './step-view';
import { useSelectedNode } from './use-selected-node';

const FOOTERS: Record<ThreadStatus, string> = {
  running: 'One branch · each step a fresh session · one PR · the harness resumes on any halt.',
  scoping: 'Pure conversation — the plan you approve here is what creates the tracks.',
  plan_review: 'Codex is reviewing the submitted plan — findings will appear in the conversation.',
  awaiting_approval: 'The approval card is inline in the conversation — that is the gate.',
  paused: 'Your paused session — reply to resume. The resume handle is yours.',
  done: 'One PR per feature · opened early as a draft, filled in live as tracks landed.',
  triaging: 'Autonomous lane — the agent parked one decision for you to answer.',
  failed: 'The run failed — read the conversation for the halt, then steer or retry.',
};

/**
 * The thread workspace — the navigator (pipeline / state panels) + the work column (Conversation or
 * Step). Resolves its own data from the org → repo → thread API. The shell's "needs you" dots come from
 * the server-owned thread-list fields (no longer fed from here); this just renders the open thread.
 */
export function ThreadWorkspace({ orgId, repoId, threadId }: ThreadRef) {
  const router = useRouter();
  const ref = useMemo<ThreadRef>(() => ({ orgId, repoId, threadId }), [orgId, repoId, threadId]);

  const { data: inbox } = useAllThreads();
  const { data: messages = [], isLoading: messagesLoading } = useThreadMessages(ref);
  const { data: pipeline, isLoading: pipelineLoading, isError: pipelineError } = usePipeline(ref);
  const { data: context, isLoading: contextLoading } = useThreadContext(ref);
  const del = useDeleteThread(ref);
  const rename = useRenameThread(ref);
  useThreadEvents(ref);

  // One send-into-this-thread action, shared by every `Markdown` in the workspace (conversation AND the
  // detail-pane spec viewer) — that's why a broken mermaid diagram's "send to Atlas" button appears in
  // both. `mutate` is referentially stable, so the context value doesn't churn.
  const sayMutate = useSay(ref).mutate;
  const markdownActions = useMemo(() => ({ sendToThread: (text: string) => sayMutate(text) }), [sayMutate]);

  // The selected node lives in `?node=` (single source of truth). A thread switch navigates to a fresh
  // clean `threadHref()` URL with no query, so the selection naturally resets — no reset effect needed.
  const { selectedNode, selectNode, openConversation } = useSelectedNode();

  // Persist the conversation/detail split ratio across reloads (per-browser). `panelIds` lets the
  // library remember the layout even though the detail panel is only conditionally mounted.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'thread-work-split',
    panelIds: ['conversation', 'detail'],
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  });
  const groupRef = useGroupRef();

  const inboxThread = useMemo(() => inbox?.find((t) => t.id === threadId), [inbox, threadId]);
  const job = pipelineJob(pipeline);

  const kind: ThreadKind = inboxThread?.kind ?? 'feat';
  const status: ThreadStatus = job
    ? toThreadStatus(job.status)
    : kind === 'event'
      ? 'triaging'
      : 'scoping';

  const approvalCard = useMemo<WebApprovalCard | null>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const card = messages[i].card;
      if (card?.type === 'approval_card') return card;
    }
    return null;
  }, [messages]);

  const meta: ThreadMeta = {
    title: inboxThread?.title ?? job?.title ?? 'Thread',
    kind,
    status,
    orgName: inboxThread?.org.name ?? 'Organization',
    orgColor: orgSwatch(),
    repoName: inboxThread?.repo.name ?? repoId,
    footer: FOOTERS[status],
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
    <div className="flex h-full min-h-0">
      <Navigator
        meta={meta}
        pipeline={pipeline}
        context={context}
        contextLoading={contextLoading}
        selectedNode={selectedNode}
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
        <Panel id="conversation" minSize="28%" className="flex min-w-0 flex-col">
          <Conversation
            threadRef={ref}
            messages={messages}
            isLoading={messagesLoading}
            live={status === 'running' || status === 'plan_review'}
            onOpenPlan={onOpenPlan}
            onSelectNode={(node) => selectNode(node, { push: true })}
          />
        </Panel>
        <Separator
          disableDoubleClick
          onDoubleClick={() => groupRef.current?.setLayout({ conversation: 50, detail: 50 })}
          title="Drag to resize · double-click to center"
          className="relative w-1.5 outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border after:transition-colors hover:after:bg-border-2 active:after:bg-text/50"
        />
        <Panel id="detail" defaultSize="50%" minSize="32%" className="flex min-w-0 flex-col">
          {selectedNode ? (
            <PhaseView
              threadRef={ref}
              pipeline={pipeline}
              pipelineLoading={pipelineLoading}
              pipelineError={pipelineError}
              messages={messages}
              approvalCard={approvalCard}
              selectedNode={selectedNode}
              onConversation={onConversation}
              onSelectNode={(node) => selectNode(node, { push: true })}
            />
          ) : (
            <EmptyPane />
          )}
        </Panel>
      </Group>
    </div>
    </MarkdownActionsProvider>
  );
}
