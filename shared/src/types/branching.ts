// Per-project git branching policy. A workstation's branch name + base + upstream are DERIVED from a
// structured intent ({kind, slug, ticket}) and the project's policy, so a feature is one branch the
// whole team works directly (no personal branches, no shared-branch merge). Stored as jsonb on
// `projects.branching_policy` (null → DEFAULT_BRANCHING_POLICY). Dependency-free so the backend host
// and the admin web share it.

export type BranchKind = 'base' | 'feature' | 'hotfix';

/**
 * One kind's rule. `from` (what the branch is cut from) and `upstream` (what it refreshes-from / PRs
 * INTO) resolve via:
 *  - `'auto'`      → the detected base (dev → develop → staging → the project default branch),
 *  - `'{default}'` → the project's default branch,
 *  - any other     → that literal branch name.
 * `name` is the branch-name template; tokens: `{slug}`, `{ticket}` (slugified intent values) and
 * `{from}` (the resolved `from` branch — used by `base`, whose branch IS the base branch).
 */
export interface BranchKindRule {
  from: string;
  name: string;
  upstream: string;
}

export interface BranchingPolicy {
  /** A long-lived workstation ON the base/integration branch (slug/ticket ignored; name `{from}`). */
  base: BranchKindRule;
  feature: BranchKindRule;
  hotfix: BranchKindRule;
}

/**
 * GitHub-flow default that ALSO adapts to gitflow via auto-detection: `'auto'` resolves to
 * `dev`/`develop`/`staging` when one exists, else the project default. So a repo WITH a `dev` branch
 * gets features off `dev` automatically; a repo without one gets them off `main`. Override per project
 * only to force a different shape (e.g. always branch features off `main`).
 */
export const DEFAULT_BRANCHING_POLICY: BranchingPolicy = {
  base: { from: 'auto', name: '{from}', upstream: '{default}' },
  feature: { from: 'auto', name: 'feature/{slug}', upstream: 'auto' },
  hotfix: { from: '{default}', name: 'hotfix/{ticket}', upstream: '{default}' },
};

/**
 * Branch/dir-safe slug: lowercase, non-alphanumeric runs → `-`, trimmed, ≤40 chars (falls back to
 * `work` when empty). Shared by the host's branch derivation and the daemon so both agree.
 */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'work'
  );
}
