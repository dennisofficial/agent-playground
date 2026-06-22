'use client';

import Link from 'next/link';
import { ROUTES } from '@/lib/routes';
import { Card } from '@/components/ui/card';
import { StatusDot, KindBadge } from '@/components/ui/badges';
import { STATUS_META } from '@/lib/api/status';
import type { WebThreadSummary } from '@/lib/api/types';

/** A thread card on the Coordinator board. */
export function ThreadCard({ summary, count }: { summary: WebThreadSummary; count: number }) {
  const status = STATUS_META[summary.status];
  return (
    <Link href={ROUTES.thread(summary.threadKey)} className="group block">
      <Card className="h-full p-4 transition group-hover:border-border-2">
        <div className="flex items-center gap-2">
          <StatusDot status={summary.status} size={8} />
          <span className="text-[11px] font-medium" style={{ color: status.color }}>
            {status.label}
          </span>
          <span className="ml-auto">
            <KindBadge kind={summary.kind} />
          </span>
        </div>
        <h3 className="mt-2.5 line-clamp-2 text-[14px] font-semibold text-text">{summary.title}</h3>
        <p className="mt-2 font-mono text-[10px] text-faint">
          {summary.channel} · {count} message{count === 1 ? '' : 's'}
        </p>
      </Card>
    </Link>
  );
}
