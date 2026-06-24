'use client';

import { InboxThreadCard } from './inbox-thread-card';
import { orgColor, orgInitials, roleLabel } from '@/lib/org-display';
import type { OrgThreadGroup } from '@/lib/api/inbox';

/**
 * The cross-org board body — threads grouped by org, each section headed by the org swatch + role. One
 * board, no switching: owned orgs first (the rail order), every org's work side by side.
 */
export function OrgBoard({
  groups,
  roleOf,
}: {
  groups: OrgThreadGroup[];
  roleOf: Map<string, string>;
}) {
  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <section key={g.orgId} className="mt-7 first:mt-0">
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-disp text-[10.5px] font-semibold text-white"
              style={{ background: orgColor(g.orgId) }}
            >
              {orgInitials(g.orgName)}
            </span>
            <span className="text-[14px] font-semibold tracking-[-0.01em] text-text">{g.orgName}</span>
            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[8.5px] text-faint">
              {roleLabel(roleOf.get(g.orgId) ?? 'member')}
            </span>
            <span className="h-px flex-1" style={{ background: 'var(--border)' }} />
          </div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {g.threads.map((t) => (
              <InboxThreadCard key={t.id} thread={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
