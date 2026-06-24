import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { RepoEntity } from '../persistence/entities';
import {
  ProjectRoutingService,
  normalizeRepoSlug,
} from './project-routing.service';

describe('normalizeRepoSlug', () => {
  it('normalizes https / ssh / bare refs to lower-cased owner/repo', () => {
    expect(normalizeRepoSlug('https://github.com/Acme/Web.git')).toBe('acme/web');
    expect(normalizeRepoSlug('git@github.com:Acme/Web.git')).toBe('acme/web');
    expect(normalizeRepoSlug('Acme/Web')).toBe('acme/web');
    expect(normalizeRepoSlug('https://github.com/Acme/Web')).toBe('acme/web');
  });

  it('returns null for unparseable refs', () => {
    expect(normalizeRepoSlug('justaword')).toBeNull();
    expect(normalizeRepoSlug('')).toBeNull();
    expect(normalizeRepoSlug(null)).toBeNull();
  });
});

function svc(repos: RepoEntity[]): ProjectRoutingService {
  const repoRepo = {
    find: async () => repos,
    findOne: async (opts: { where: { id: string; org_id: string } }) =>
      repos.find(
        (r) => r.id === opts.where.id && r.org_id === opts.where.org_id,
      ) ?? null,
  } as unknown as Repository<RepoEntity>;
  return new ProjectRoutingService(repoRepo);
}

const repo = (over: Partial<RepoEntity>): RepoEntity =>
  ({ id: 'repo-web', org_id: 'T1', slug: 'web', git_url: 'https://github.com/acme/web.git', ...over }) as RepoEntity;

describe('ProjectRoutingService', () => {
  it('routes a github repo across orgs by normalized git_url', async () => {
    const s = svc([repo({})]);
    const route = await s.routeGithubRepo('Acme/Web'); // case-insensitive
    expect(route).not.toBeNull();
    expect(route!.orgId).toBe('T1');
    expect(route!.repoId).toBe('repo-web'); // the repo's uuid id
    expect(route!.repo.slug).toBe('web');
  });

  it('returns null for an unregistered github repo', async () => {
    expect(await svc([repo({})]).routeGithubRepo('other/repo')).toBeNull();
  });

  it('routes a generic webhook by (orgId, repoId-uuid)', async () => {
    const s = svc([repo({})]);
    expect((await s.routeProjectId('T1', 'repo-web'))!.repoId).toBe('repo-web');
    expect(await s.routeProjectId('T1', 'nope')).toBeNull();
  });
});
