'use client';

import { KindBadge } from '@/components/ui/badges';
import { orgColor, timeAgo } from '@/lib/org-display';
import type { InboxThread } from '@/lib/api/inbox';

/**
 * A thread card on the cross-org board. Read-only this phase (opening a thread is deferred), so it's a
 * static card — kind badge, title, and an `org · repo` label so the operator always knows whose work it
 * is. Status dots / "needs you" are intentionally absent (the thread list carries no such signal yet).
 */
export function InboxThreadCard({ thread }: { thread: InboxThread }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4" style={{ boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: orgColor(thread.org.id) }} />
        <KindBadge kind={thread.kind} />
        <div className="flex-1" />
        <span className="font-mono text-[9.5px] text-faint">{timeAgo(thread.createdAt)}</span>
      </div>
      <div className="text-[14px] font-semibold leading-tight tracking-[-0.01em] text-text">{thread.title}</div>
      <div className="mt-2 font-mono text-[9.5px] text-faint">
        {thread.org.name} · {thread.repo.name}
      </div>
    </div>
  );
}
