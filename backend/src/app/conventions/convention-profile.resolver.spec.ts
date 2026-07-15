import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { ConventionProfileResolver } from './convention-profile.resolver';
import type {
  ConventionProfileEntity,
  RepoEntity,
} from '../persistence/entities';

/**
 * The resolver's misfire guard is the load-bearing behavior: `resolveForRepo` returns null unless the repo
 * has a pointer AND the pointed-at profile exists with a non-empty body. `attach` validates the slug and
 * forces the repo scope.
 */
const ORG = 'org-1';
const REPO = 'repo-1';

function make(opts: {
  repo?: Partial<RepoEntity> | null;
  profile?: Partial<ConventionProfileEntity> | null;
}) {
  const profiles = {
    findOne: vi.fn().mockResolvedValue(opts.profile ?? null),
    find: vi.fn().mockResolvedValue([]),
  } as unknown as Repository<ConventionProfileEntity>;
  const repos = {
    findOne: vi.fn().mockResolvedValue(opts.repo ?? null),
    update: vi.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Repository<RepoEntity>;
  return {
    resolver: new ConventionProfileResolver(profiles, repos),
    profiles,
    repos,
  };
}

describe('ConventionProfileResolver.resolveForRepo', () => {
  it('returns null when the repo has no pointer', async () => {
    const { resolver } = make({
      repo: { id: REPO, convention_profile_slug: null },
    });
    expect(await resolver.resolveForRepo(ORG, REPO)).toBeNull();
  });

  it('returns null when the repo row is missing', async () => {
    const { resolver } = make({ repo: null });
    expect(await resolver.resolveForRepo(ORG, REPO)).toBeNull();
  });

  it('returns null when the pointer dangles to a deleted profile', async () => {
    const { resolver } = make({
      repo: { id: REPO, convention_profile_slug: 'gone' },
      profile: null,
    });
    expect(await resolver.resolveForRepo(ORG, REPO)).toBeNull();
  });

  it('returns null when the attached profile has an empty body', async () => {
    const { resolver } = make({
      repo: { id: REPO, convention_profile_slug: 'p' },
      profile: { slug: 'p', name: 'P', body: '   ' },
    });
    expect(await resolver.resolveForRepo(ORG, REPO)).toBeNull();
  });

  it('returns {name, body} when a non-empty profile is attached', async () => {
    const { resolver } = make({
      repo: { id: REPO, convention_profile_slug: 'p' },
      profile: { slug: 'p', name: 'House', body: 'Use shared/ contract.' },
    });
    expect(await resolver.resolveForRepo(ORG, REPO)).toEqual({
      name: 'House',
      body: 'Use shared/ contract.',
    });
  });
});

describe('ConventionProfileResolver.attach', () => {
  it('rejects a slug that does not exist in the org', async () => {
    const { resolver, repos } = make({ profile: null });
    await expect(resolver.attach(ORG, REPO, 'nope')).rejects.toThrow(
      /does not exist/,
    );
    expect(repos.update).not.toHaveBeenCalled();
  });

  it('sets the pointer for a valid slug (scoped to org + repo)', async () => {
    const { resolver, repos } = make({
      profile: { slug: 'p', name: 'P', body: 'x' },
    });
    await resolver.attach(ORG, REPO, 'p');
    expect(repos.update).toHaveBeenCalledWith(
      { id: REPO, org_id: ORG },
      { convention_profile_slug: 'p' },
    );
  });

  it('clears the pointer with null WITHOUT a slug lookup', async () => {
    const { resolver, repos, profiles } = make({});
    await resolver.attach(ORG, REPO, null);
    expect(profiles.findOne).not.toHaveBeenCalled();
    expect(repos.update).toHaveBeenCalledWith(
      { id: REPO, org_id: ORG },
      { convention_profile_slug: null },
    );
  });
});
