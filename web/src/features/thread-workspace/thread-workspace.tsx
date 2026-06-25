'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAllThreads } from '@/lib/api/inbox';
import { useThreadMessages, usePipeline, useDeleteThread, useRenameThread } from '@/lib/api/thread-queries';
import { useThreadEvents } from '@/lib/api/thread-events';
import { setThreadStatus } from '@/lib/api/thread-status';
import { toThreadStatus } from '@/lib/api/status';
import { orgSwatch } from '@/lib/org-display';
import { ROUTES } from '@/lib/routes';
import { pipelineJob, type ThreadRef } from '@/lib/api/thread-api';
import type { ThreadKind, ThreadStatus, WebApprovalCard } from '@/lib/api/types';
import { Navigator, type ThreadMeta } from './navigator';
import { Conversation } from './conversation';
import { PhaseView } from './phase-view';

type WorkMode = 'conversation' | 'phase';

const FOOTERS: Record<ThreadStatus, string> = {
  running: 'One branch · each phase a fresh session · one PR · the harness resumes on any halt.',
  scoping: 'Pure conversation — the plan you approve here is what creates the sections.',
  awaiting_approval: 'The approval card is inline in the conversation — that is the gate.',
  paused: 'Your paused session — reply to resume. The resume handle is yours.',
  done: 'One PR per feature · opened early as a draft, filled in live as sections landed.',
  triaging: 'Autonomous lane — the agent parked one decision for you to answer.',
  failed: 'The run failed — read the conversation for the halt, then steer or retry.',
};

/**
 * The thread workspace — the navigator (pipeline / state panels) + the work column (Conversation or
 * Phase). Resolves its own data from the org → repo → thread API and feeds the open thread's real status
 * into the shared status seam (`setThreadStatus`) so the shell lights it up.
 */
export function ThreadWorkspace({ orgId, repoId, threadId }: ThreadRef) {
  const router = useRouter();
  const ref = useMemo<ThreadRef>(() => ({ orgId, repoId, threadId }), [orgId, repoId, threadId]);

  const { data: inbox } = useAllThreads();
  const { data: messages = [], isLoading: messagesLoading } = useThreadMessages(ref);
  const { data: pipeline } = usePipeline(ref);
  const del = useDeleteThread(ref);
  const rename = useRenameThread(ref);
  useThreadEvents(ref);

  const [workMode, setWorkMode] = useState<WorkMode>('conversation');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  // New thread → reset the work column to the conversation.
  useEffect(() => {
    setWorkMode('conversation');
    setSelectedNode(null);
  }, [threadId]);

  const inboxThread = useMemo(() => inbox?.find((t) => t.id === threadId), [inbox, threadId]);
  const job = pipelineJob(pipeline);

  const kind: ThreadKind = inboxThread?.kind ?? 'feat';
  const status: ThreadStatus = job
    ? toThreadStatus(job.status)
    : kind === 'event'
      ? 'triaging'
      : 'scoping';
  const needsYou = status === 'awaiting_approval' || status === 'paused' || status === 'triaging';

  // Feed the open thread's real status into the shared seam (the only live source today).
  useEffect(() => {
    setThreadStatus(threadId, { status, needsYou });
  }, [threadId, status, needsYou]);

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

  const onConversation = () => setWorkMode('conversation');
  const onSelectNode = (node: string) => {
    setSelectedNode(node);
    setWorkMode('phase');
  };
  const onOpenPlan = () => {
    setSelectedNode('plan');
    setWorkMode('phase');
  };
  const onRename = (title: string) => rename.mutate(title);
  const onDelete = () =>
    del.mutate(undefined, {
      onSuccess: () => {
        setThreadStatus(threadId, null);
        router.push(ROUTES.workspace());
      },
    });

  return (
    <div className="flex h-full min-h-0">
      <Navigator
        meta={meta}
        pipeline={pipeline}
        selectedNode={selectedNode}
        convoActive={workMode === 'conversation'}
        onConversation={onConversation}
        onSelectNode={onSelectNode}
        onRename={onRename}
        onDelete={onDelete}
        deleting={del.isPending}
      />
      <div className="min-w-0 flex-1">
        {workMode === 'phase' && selectedNode ? (
          <PhaseView
            threadRef={ref}
            pipeline={pipeline}
            messages={messages}
            approvalCard={approvalCard}
            selectedNode={selectedNode}
            onConversation={onConversation}
          />
        ) : (
          <Conversation
            threadRef={ref}
            messages={messages}
            isLoading={messagesLoading}
            live={status === 'running'}
            onOpenPlan={onOpenPlan}
          />
        )}
      </div>
    </div>
  );
}
