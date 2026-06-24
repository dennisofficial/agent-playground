'use client';

import Link from 'next/link';
import { KindBadge, StatusDot } from '@/components/ui/badges';
import { orgColor, timeAgo } from '@/lib/org-display';
import { threadHref } from '@/lib/routes';
import { useThreadStatus } from '@/lib/api/thread-status';
import { STATUS_META } from '@/lib/api/status';
import type { InboxThread } from '@/lib/api/inbox';

/**
 * A thread card on the cross-org board — opens the thread workspace. It carries an `org · repo` label so
 * the operator always knows whose work it is, and a live status dot when the shared status seam knows it
 * (today only the open thread; lights up everywhere when the realtime feed lands — see thread-status.ts).
 */
export function InboxThreadCard({ thread }: { thread: InboxThread }) {
  const status = useThreadStatus(thread.id);
  return (
    <Link
      href={threadHref({ orgId: thread.org.id, repoId: thread.repo.id, threadId: thread.id })}
      className="block rounded-lg border border-border bg-surface p-4 transition hover:border-border-2"
      style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: orgColor(thread.org.id) }} />
        <KindBadge kind={thread.kind} />
        <div className="flex-1" />
        {status?.needsYou ? (
          <span className="flex items-center gap-1.5 font-mono text-[9px] font-semibold text-rose">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--rose)' }} />
            needs you
          </span>
        ) : status ? (
          <span className="flex items-center gap-1.5 font-mono text-[9.5px] text-faint">
            <StatusDot status={status.status} size={7} />
            {STATUS_META[status.status].label}
          </span>
        ) : (
          <span className="font-mono text-[9.5px] text-faint">{timeAgo(thread.createdAt)}</span>
        )}
      </div>
      <div className="text-[14px] font-semibold leading-tight tracking-[-0.01em] text-text">{thread.title}</div>
      <div className="mt-2 font-mono text-[9.5px] text-faint">
        {thread.org.name} · {thread.repo.name}
      </div>
    </Link>
  );
}
