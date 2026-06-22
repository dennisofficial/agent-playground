'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutGrid, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ROUTES } from '@/lib/routes';
import { useChannel } from '@/components/providers/channel-provider';
import { useThreadList } from '@/lib/api/threads';
import { ThreadRow } from './thread-row';

function activeThreadKey(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean); // ['workspace', '<key>', ...]
  if (parts[0] === 'workspace' && parts[1]) return decodeURIComponent(parts[1]);
  return null;
}

/** Left sidebar (240px): New thread · Overview · THREADS list. */
export function Sidebar() {
  const pathname = usePathname();
  const { activeChannel } = useChannel();
  const { threads, counts, isLoading } = useThreadList(activeChannel);

  const activeKey = activeThreadKey(pathname);
  const onOverview = pathname === ROUTES.workspace();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
      <div className="p-3">
        <Link
          href={ROUTES.newThread()}
          className="flex items-center justify-center gap-2 rounded-md border py-2 text-[12.5px] font-medium text-accent transition hover:brightness-105"
          style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}
        >
          <Plus size={15} /> New thread
        </Link>
      </div>

      <nav className="px-3 pb-2">
        <Link
          href={ROUTES.workspace()}
          className={cn(
            'flex items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] font-medium transition',
            onOverview ? 'text-text' : 'text-dim hover:bg-surface-2',
          )}
          style={onOverview ? { background: 'var(--surface-2)' } : undefined}
        >
          <LayoutGrid size={14} className="text-faint" />
          <span className="flex-1">Overview</span>
          <span className="font-mono text-[10px] text-faint">{threads.length}</span>
        </Link>
      </nav>

      <div className="px-4 pb-1 pt-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-faint">Threads</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {isLoading ? (
          <p className="px-2 py-3 text-[12px] text-faint">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-faint">No threads in this channel yet.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {threads.map((t) => (
              <ThreadRow
                key={t.threadKey}
                summary={t}
                count={counts.get(t.threadTs) ?? 0}
                active={activeKey === decodeURIComponent(t.threadKey)}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
