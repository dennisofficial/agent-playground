import type { InboxThread } from "./inbox";

export type JobSection =
  | "planning"
  | "awaiting"
  | "building"
  | "done"
  | "pr_open"
  | "merged";

export const SECTION_ORDER: JobSection[] = [
  "planning",
  "awaiting",
  "building",
  "done",
  "pr_open",
  "merged",
];

export const SECTION_LABEL: Record<JobSection, string> = {
  planning: "Planning",
  awaiting: "Awaiting",
  building: "Building",
  done: "Done",
  pr_open: "PR Open",
  merged: "Merged",
};

/** d1: build phase wins; PR state only decides once done. Returns null → not shown. */
export function sectionOf(t: InboxThread): JobSection | null {
  switch (t.status) {
    case "planning":
    case "plan_review":
    case "triaging":
      return "planning";
    case "awaiting_approval":
    case "awaiting_ship_review":
      return "awaiting";
    case "running":
      return "building";
    case "done":
      if (t.pr?.state === "open") return "pr_open";
      if (t.pr?.state === "merged") return "merged";
      return "done"; // no PR or closed PR
    default:
      return null; // cancelled, deleting → hidden
  }
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
  return SECTION_ORDER.filter((s) => by.has(s)) // conditional render: empty sections omitted
    .map((s) => ({ section: s, threads: by.get(s)! }));
}
