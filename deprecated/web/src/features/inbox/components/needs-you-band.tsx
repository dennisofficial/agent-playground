'use client';

import { StatusPie } from '@/components/ui/badges';
import type { InboxThread } from '@/lib/api/inbox';
import { STATUS_META } from '@/lib/api/status';
import { SITE_MAP } from '@/lib/site-map';
import { orgSwatch } from '@/utils/org-display';
import Link from 'next/link';

/**
 * The cross-org "Needs you" band — every thread whose status is yours to act on (approvals routed to you,
 * your triage, your paused threads), across every org. Reads the server-owned `needsYou` field on each
 * thread row, so it covers ALL threads (not just the open one) and stays live via the realtime feed.
 */
export function NeedsYouBand({ threads }: { threads: InboxThread[] }) {
  const attention = threads.filter((t) => t.needsYou);
  if (attention.length === 0) return null;

  return (
    <div
      className="mb-6 rounded-lg border p-4"
      style={{
        borderColor: 'var(--accent-line)',
        background: 'var(--accent-soft)',
      }}
    >
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className="pulse-dot h-1.5 w-1.5 rounded-full"
          style={{ background: 'var(--accent)' }}
        />
        <span className="font-disp text-[13px] font-semibold text-accent">Needs you</span>
        <span className="font-mono text-[10px] text-dim">
          {attention.length} yours to act on · approvals, triage &amp; paused threads
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(238px,1fr))] gap-3">
        {attention.map((t) => (
          <Link
            key={t.id}
            href={SITE_MAP.jobs.job(t.id)()}
            className="rounded-md border border-border bg-surface p-3 transition hover:border-border-2"
          >
            <div className="mb-2 flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-sm"
                style={{ background: orgSwatch() }}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-faint">
                {t.org.name}
              </span>
              <StatusPie status={t.status} halted={t.halted} size={14} />
            </div>
            <div className="text-[13px] font-semibold leading-tight text-text">{t.title}</div>
            <div className="mt-2 font-mono text-[9px] text-accent">
              {STATUS_META[t.status].label} ↗
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
