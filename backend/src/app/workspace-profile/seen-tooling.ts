/**
 * The per-repo seen-tooling ledger entry (install-awareness nudge, `repos.profile_seen_tooling`). See
 * {@link RepoEntity.profile_seen_tooling} for the column doc and `WorkspaceConfigStore.applyToolingTransition`
 * for the atomic read-modify-write.
 */
export type SeenTooling = {
  /** Normalized identifier, `"<ecosystem>:<name>"` — e.g. "pnpm:eslint", "apt:doctl", "cargo:ripgrep". */
  key: string;
  /** Coarse class driving the checklist's angle. */
  kind: 'repo-manifest' | 'env-binary';
  /** ISO-8601 timestamp of the transition that recorded this key (audit only; membership is by `key`). */
  firstSeenAt: string;
};
