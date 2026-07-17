import { describe, expect, it, vi } from 'vitest';
import { GitIdentityService } from './git-identity.service';
import type { GithubPrService } from './github-pr.service';

const fakeGithub = (user: { login: string; id: number; name: string | null } | null) => {
  const getAuthenticatedUser = vi.fn(async () => user);
  return { getAuthenticatedUser } as unknown as GithubPrService;
};

describe('GitIdentityService.resolve', () => {
  it('resolves and formats the noreply email', async () => {
    const github = fakeGithub({
      login: 'octocat',
      id: 583231,
      name: 'The Octocat',
    });
    const svc = new GitIdentityService(github);
    expect(await svc.resolve('TOK')).toEqual({
      name: 'The Octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
  });

  it('falls back to the login when name is null or blank', async () => {
    const github = fakeGithub({ login: 'octocat', id: 583231, name: null });
    const svc = new GitIdentityService(github);
    expect(await svc.resolve('TOK')).toEqual({
      name: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });

    const githubBlank = fakeGithub({
      login: 'octocat',
      id: 583231,
      name: '   ',
    });
    const svcBlank = new GitIdentityService(githubBlank);
    expect(await svcBlank.resolve('TOK')).toEqual({
      name: 'octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
  });

  it('memoizes: two resolves with the same token call the API only once', async () => {
    const github = fakeGithub({
      login: 'octocat',
      id: 583231,
      name: 'The Octocat',
    });
    const svc = new GitIdentityService(github);
    await svc.resolve('TOK');
    await svc.resolve('TOK');
    expect(github.getAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for an undefined token, and never calls the API', async () => {
    const github = fakeGithub(null);
    const svc = new GitIdentityService(github);
    expect(await svc.resolve(undefined)).toBeUndefined();
    expect(github.getAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('returns undefined when getAuthenticatedUser returns null, without caching the miss', async () => {
    const github = fakeGithub(null);
    const svc = new GitIdentityService(github);
    expect(await svc.resolve('TOK')).toBeUndefined();
    expect(await svc.resolve('TOK')).toBeUndefined();
    expect(github.getAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it('does not cache a thrown lookup failure, so a later resolve can recover', async () => {
    const getAuthenticatedUser = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        login: 'octocat',
        id: 583231,
        name: 'The Octocat',
      });
    const svc = new GitIdentityService({
      getAuthenticatedUser,
    } as unknown as GithubPrService);

    expect(await svc.resolve('TOK')).toBeUndefined();
    expect(await svc.resolve('TOK')).toEqual({
      name: 'The Octocat',
      email: '583231+octocat@users.noreply.github.com',
    });
    expect(getAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});
