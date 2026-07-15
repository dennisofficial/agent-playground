import type { RepoEntity } from '../persistence/entities/repo.entity';

/**
 * Neutral built-in fallback prefix (`feature/<id8>`) when a repo has no {@link RepoEntity.branch_prefix}
 * configured.
 */
export const DEFAULT_BRANCH_PREFIX = 'feature/';

/**
 * Compute the CANONICAL feature-branch name for a job: `<prefix><job-id-first-8>`.
 *
 * The host computes this name (so GitHub events correlate back to the job by branch), but Atlas OWNS
 * the actual `git checkout -b` in the sandbox. Deterministic + job-id-encoded → correlation stays
 * trivial even though the branch is cut in-sandbox. A per-repo prefix lets a repo enforce its own
 * convention (e.g. `feat/`) without random names.
 */
export function computeFeatureBranchName(
  repo: Pick<RepoEntity, 'branch_prefix'>,
  jobId: string,
): string {
  const prefix = repo.branch_prefix?.trim() || DEFAULT_BRANCH_PREFIX;
  return `${prefix}${jobId.slice(0, 8)}`;
}

/**
 * Validate a branch name against the repo's optional {@link RepoEntity.branch_regex}. This is a soft
 * convention guard (surface a warning), NOT a hard block — Atlas owns git in-sandbox and there is no
 * host chokepoint. Null/empty regex → always valid; an unparseable regex config also passes (never
 * wedge a job on a bad config).
 */
export function isBranchNameValid(
  repo: Pick<RepoEntity, 'branch_regex'>,
  name: string,
): boolean {
  const pattern = repo.branch_regex?.trim();
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return true;
  }
}
