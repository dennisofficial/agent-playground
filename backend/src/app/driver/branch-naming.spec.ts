import { describe, expect, it } from 'vitest';
import type { RepoEntity } from '../persistence/entities/repo.entity';
import {
  computeFeatureBranchName,
  DEFAULT_BRANCH_PREFIX,
  isBranchNameValid,
} from './branch-naming';

const JOB = 'a1b2c3d4-1111-2222-3333-444455556666';

function repo(over: Partial<RepoEntity> = {}): RepoEntity {
  return { branch_prefix: null, branch_regex: null, ...over } as RepoEntity;
}

describe('computeFeatureBranchName', () => {
  it('uses the built-in default prefix + first 8 chars of the job id when no prefix is set', () => {
    expect(computeFeatureBranchName(repo(), JOB)).toBe(`${DEFAULT_BRANCH_PREFIX}a1b2c3d4`);
  });

  it('honours a per-repo prefix (convention enforcement, e.g. feat/)', () => {
    expect(computeFeatureBranchName(repo({ branch_prefix: 'feat/' }), JOB)).toBe('feat/a1b2c3d4');
  });

  it('trims whitespace and falls back to the default on an empty prefix', () => {
    expect(computeFeatureBranchName(repo({ branch_prefix: '   ' }), JOB)).toBe(
      `${DEFAULT_BRANCH_PREFIX}a1b2c3d4`,
    );
  });
});

describe('isBranchNameValid', () => {
  it('passes when no regex is configured', () => {
    expect(isBranchNameValid(repo(), 'anything/goes')).toBe(true);
  });

  it('validates against a configured regex', () => {
    const r = repo({ branch_regex: '^feat/[a-f0-9]{8}$' });
    expect(isBranchNameValid(r, 'feat/a1b2c3d4')).toBe(true);
    expect(isBranchNameValid(r, 'random-branch')).toBe(false);
  });

  it('never wedges on an unparseable regex config (passes)', () => {
    expect(isBranchNameValid(repo({ branch_regex: '([' }), 'whatever')).toBe(true);
  });
});
