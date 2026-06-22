'use client';

import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useChannel } from '@/components/providers/channel-provider';
import { ThreadCard } from '@/features/thread-list/components/thread-card';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';
import { useThreadList } from '@/lib/api/threads';

/**
 * Coordinator overview — the board of threads that replaces a global main chat. Derived from the
 * active channel's outbox (demo/live-outbox only; see BACKEND_GAPS.md #1).
 */
export default function CoordinatorPage() {
  const { activeChannel } = useChannel();
  const { threads, counts, isLoading } = useThreadList(activeChannel);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="font-disp text-[22px] font-semibold text-text">Coordinator</h1>
            <p className="mt-1 text-[13px] text-dim">
              Every unit of work is a thread — its own session, branch, and PR.
            </p>
          </div>
          <Link href={ROUTES.newThread()}>
            <Button icon={<Plus size={15} />}>New thread</Button>
          </Link>
        </div>

        {!activeChannel ? (
          <EmptyBoard
            title="Connect a repo to begin"
            body="No active channel yet. Once Atlas is bound to a repo, its threads appear here."
          />
        ) : isLoading ? (
          <p className="mt-10 text-[13px] text-faint">Loading threads…</p>
        ) : threads.length === 0 ? (
          <EmptyBoard
            title="No threads yet"
            body="Start a thread to spin up an isolated workspace where a Claude agent reads your code."
          />
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {threads.map((t) => (
              <ThreadCard key={t.threadKey} summary={t} count={counts.get(t.threadTs) ?? 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyBoard({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-10 flex flex-col items-center rounded-lg border border-dashed border-border-2 px-6 py-16 text-center">
      <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] text-dim">{body}</p>
      <Link href={ROUTES.newThread()} className="mt-5">
        <Button icon={<Plus size={15} />}>Start a thread</Button>
      </Link>
    </div>
  );
}
