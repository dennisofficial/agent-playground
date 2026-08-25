/**
 * Per-job auto-merge settings — the WIRE CONTRACT. Single-sourced here (like `AutoApproveMode`) so the
 * backend and web console can't drift on the GitHub merge strategy.
 *
 * Auto-merge is a plain boolean axis (there is NO `AUTO_MERGE_MODE` enum) — the method and delete-branch
 * are independent knobs, not modes, and are orthogonal to `AUTO_APPROVE_MODES`.
 */
export const AUTO_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export type AutoMergeMethod = (typeof AUTO_MERGE_METHODS)[number];

export const isAutoMergeMethod = (v: unknown): v is AutoMergeMethod =>
  typeof v === 'string' && (AUTO_MERGE_METHODS as readonly string[]).includes(v);
