import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ConventionProfilesController } from './convention-profiles.controller';
import type { ConventionProfileResolver } from './convention-profile.resolver';

/**
 * The console API surface: list/upsert/delete profiles + attach one to a repo. Guards (membership/owner)
 * are enforced by decorators (covered by the guards' own specs); here we verify the controller's own logic —
 * slug validation, org-scoping via `@CurrentOrg`, and the clear-with-null attach path.
 */
const ORG = { id: 'org-1' } as never;

function make() {
  const resolver = {
    allProfiles: vi
      .fn()
      .mockResolvedValue([
        { slug: 'p', name: 'P', body: 'b', detectHint: null },
      ]),
    attachedSlug: vi.fn().mockResolvedValue('p'),
    upsertProfile: vi.fn().mockResolvedValue(undefined),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConventionProfileResolver;
  return { controller: new ConventionProfilesController(resolver), resolver };
}

describe('ConventionProfilesController', () => {
  let c: ReturnType<typeof make>;
  beforeEach(() => (c = make()));

  it('lists profiles for the current org', async () => {
    expect(await c.controller.list(ORG)).toEqual({
      profiles: [{ slug: 'p', name: 'P', body: 'b', detectHint: null }],
    });
    expect(c.resolver.allProfiles).toHaveBeenCalledWith('org-1');
  });

  it('reads the repo attachment', async () => {
    expect(await c.controller.attached(ORG, 'repo-1')).toEqual({ slug: 'p' });
    expect(c.resolver.attachedSlug).toHaveBeenCalledWith('org-1', 'repo-1');
  });

  it('upserts a profile with a valid slug', async () => {
    await c.controller.set(ORG, 'nestjs-next-shared', {
      name: 'N',
      body: 'B',
      detectHint: 'H',
    });
    expect(c.resolver.upsertProfile).toHaveBeenCalledWith(
      'org-1',
      'nestjs-next-shared',
      {
        name: 'N',
        body: 'B',
        detectHint: 'H',
      },
    );
  });

  it('rejects an invalid slug', async () => {
    await expect(
      c.controller.set(ORG, 'Bad Slug!', { name: 'N', body: 'B' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(c.resolver.upsertProfile).not.toHaveBeenCalled();
  });

  it('attaches a profile to a repo', async () => {
    expect(await c.controller.attach(ORG, 'repo-1', { slug: 'p' })).toEqual({
      ok: true,
      slug: 'p',
    });
    expect(c.resolver.attach).toHaveBeenCalledWith('org-1', 'repo-1', 'p');
  });

  it('clears the attachment with null slug', async () => {
    expect(await c.controller.attach(ORG, 'repo-1', { slug: null })).toEqual({
      ok: true,
      slug: null,
    });
    expect(c.resolver.attach).toHaveBeenCalledWith('org-1', 'repo-1', null);
  });

  it('surfaces a bad attach (unknown slug) as a 400', async () => {
    (c.resolver.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('does not exist'),
    );
    await expect(
      c.controller.attach(ORG, 'repo-1', { slug: 'nope' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
