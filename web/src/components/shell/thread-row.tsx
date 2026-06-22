'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { ROUTES } from '@/lib/routes';
import { StatusDot, KindBadge } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import type { WebThreadSummary } from '@/lib/api/types';

/** A sidebar thread row: status dot · title · kind badge, over a mono meta line. */
export function ThreadRow({
  summary,
  count,
  active,
}: {
  summary: WebThreadSummary;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={ROUTES.thread(summary.threadKey)}
      className={cn(
        'block rounded-md border px-2.5 py-2 transition',
        active ? 'border-[var(--accent-line)]' : 'border-transparent hover:bg-surface-2',
      )}
      style={active ? { background: 'var(--accent-soft)' } : undefined}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={summary.status} size={7} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text">
          {summary.title}
        </span>
        <KindBadge kind={summary.kind} />
      </div>
      <div className="mt-1 pl-[15px] font-mono text-[9.5px] text-faint">
        {STATUS_META[summary.status].label.toLowerCase()} · {count} msg
      </div>
    </Link>
  );
}
