import type { RepoEntity } from '../persistence/entities/repo.entity';

export const DEFAULT_BRANCH_PREFIX = 'feature/';

export function computeFeatureBranchName(
  repo: Pick<RepoEntity, 'branch_prefix'>,
  jobId: string,
): string {
  const prefix = repo.branch_prefix?.trim() || DEFAULT_BRANCH_PREFIX;
  return `${prefix}${jobId.slice(0, 8)}`;
}

export function isBranchNameValid(repo: Pick<RepoEntity, 'branch_regex'>, name: string): boolean {
  const pattern = repo.branch_regex?.trim();
  if (!pattern) return true;
  try {
    return new RegExp(pattern).test(name);
  } catch {
    return true;
  }
}
