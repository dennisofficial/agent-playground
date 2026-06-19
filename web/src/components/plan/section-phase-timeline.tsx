'use client';

import type { SectionView } from '@workspace/shared';
import { statusBadgeClass } from './status';

/**
 * Deterministic, system-derived view of a feature pipeline: each section as a lane, its build phases
 * as status-colored chips. Rendered straight from the DB (sections → phases), so it's always accurate
 * regardless of what the planner drew in prose.
 */
export function SectionPhaseTimeline({ sections }: { sections: SectionView[] }) {
  if (sections.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {sections.map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="flex w-40 shrink-0 items-center gap-2">
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{s.ordinal}</span>
            <span className="truncate text-sm font-medium capitalize text-zinc-800 dark:text-zinc-200">
              {s.name}
            </span>
          </div>
          <Pill status={s.status}>{s.status.replace(/_/g, ' ')}</Pill>
          {s.phases.length > 0 ? (
            <div className="flex flex-1 flex-wrap items-center gap-1.5">
              {s.phases.map((p) => (
                <Pill key={p.id} status={p.status} title={`${p.status}`}>
                  {p.title ? p.title : `phase ${p.planPhaseId}`}
                </Pill>
              ))}
            </div>
          ) : (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">no phases yet</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Pill({
  status,
  children,
  title,
}: {
  status: string;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-block max-w-[14rem] truncate rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClass(status)}`}
    >
      {children}
    </span>
  );
}
