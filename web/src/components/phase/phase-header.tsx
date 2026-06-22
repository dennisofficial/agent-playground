'use client';

import Link from 'next/link';
import { cn } from '@/lib/cn';
import { ROUTES, type PhaseTab } from '@/lib/routes';

const TABS: PhaseTab[] = ['transcript', 'diff', 'logs'];

/** Phase header + Transcript/Diff/Logs tab bar (DRY — lives in the phase layout, persists across tabs). */
export function PhaseHeader({
  threadKey,
  phaseId,
  activeTab,
}: {
  threadKey: string;
  phaseId: string;
  activeTab: PhaseTab | null;
}) {
  const label = phaseId.startsWith('s') ? `Section §${phaseId.slice(1)} · build` : phaseId;
  return (
    <div className="shrink-0 border-b border-border bg-panel px-6 pt-3.5">
      <div className="flex items-center gap-2.5">
        <h2 className="font-disp text-[15px] font-semibold text-text">{label}</h2>
        <span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[9.5px] text-dim">
          Claude · execute
        </span>
        <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
      </div>
      <div className="mt-3 flex gap-4">
        {TABS.map((tab) => {
          const active = (activeTab ?? 'transcript') === tab;
          return (
            <Link
              key={tab}
              href={ROUTES.threadPhase(threadKey, phaseId, tab)}
              className={cn(
                'relative pb-2 text-[12.5px] capitalize transition',
                active ? 'text-text' : 'text-faint hover:text-dim',
              )}
            >
              {tab}
              {active ? (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ background: 'var(--accent)' }} />
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
