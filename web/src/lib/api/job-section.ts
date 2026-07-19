import type { InboxThread } from './inbox';

export type JobSection =
  | 'planning'
  | 'reviewing'
  | 'blocked'
  | 'awaiting'
  | 'building'
  | 'master_review'
  | 'amending'
  | 'ready_to_ship'
  | 'done'
  | 'pr_open'
  | 'merged'
  | 'archived';

export const SECTION_ORDER: JobSection[] = [
  'blocked',
  'planning',
  'reviewing',
  'awaiting',
  'building',
  'master_review',
  'amending',
  'ready_to_ship',
  'done',
  'pr_open',
  'merged',
  'archived',
];

export const SECTION_LABEL: Record<JobSection, string> = {
  planning: 'Planning',
  reviewing: 'Reviewing',
  blocked: 'Blocked',
  awaiting: 'Awaiting Approval',
  building: 'Building',
  master_review: 'Master Review',
  amending: 'Amending',
  ready_to_ship: 'Ready to Ship',
  done: 'Done',
  pr_open: 'PR Open',
  merged: 'Merged',
  archived: 'Archived',
};

/** d1: build phase wins; PR state only decides once done. Returns null → not shown. */
export function sectionOf(t: InboxThread): JobSection | null {
  switch (t.status) {
    case 'planning':
    case 'plan_review':
      return 'reviewing';
    case 'blocked':
      return 'blocked';
    case 'awaiting_approval':
      return 'awaiting';
    case 'amending':
      return 'amending';
    case 'awaiting_ship_review':
      return 'ready_to_ship';
    case 'running':
      // The ship-time Codex master review (after all builder threads) keeps the `running` status;
      // surface it as its own section rather than an indistinct "Building" row.
      if (t.activity === 'master_review') return 'master_review';
      // A shipping job re-uses the `running` status while its PR opens — keep it in "Ready to Ship"
      // (showing the `running` working spinner) rather than teleporting it to "Building".
      return t.shipping ? 'ready_to_ship' : 'building';
    case 'done':
      if (t.pr?.state === 'open') return 'pr_open';
      if (t.pr?.state === 'merged') return 'merged';
      return 'done'; // no PR or closed PR
    case 'archived':
      return 'archived';
    default:
      return null; // cancelled, deleting → hidden
  }
}

/** The thread's anchor ts for its current (raw) status — first-entry into that status, falling back to
 *  `createdAt` for pre-migration rows or a status missing from the map. */
function anchorMs(t: InboxThread): number {
  const iso = t.sectionFirstEntered?.[t.rawStatus];
  return Date.parse(iso ?? t.createdAt);
}

export function groupThreadsBySection(
  threads: InboxThread[],
): { section: JobSection; threads: InboxThread[] }[] {
  const by = new Map<JobSection, InboxThread[]>();
  for (const t of threads) {
    const s = sectionOf(t);
    if (!s) continue;
    (by.get(s) ?? by.set(s, []).get(s)!).push(t);
  }
  // Newest arrival into the section on top; a kickback (re-entry) is a no-op on the anchor, so it
  // restores the job's original slot rather than floating it back to the top.
  for (const list of by.values()) list.sort((a, b) => anchorMs(b) - anchorMs(a));
  return SECTION_ORDER.filter((s) => by.has(s)) // conditional render: empty sections omitted
    .map((s) => ({ section: s, threads: by.get(s)! }));
}
