import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { AtlasChannel, AtlasProject } from '../persistence/entities';
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

function svc(projects: AtlasProject[], channels: AtlasChannel[]): ProjectRoutingService {
  const projectRepo = {
    find: async (opts?: { where?: { team_id?: string } }) =>
      opts?.where?.team_id ? projects.filter((p) => p.team_id === opts.where!.team_id) : projects,
    findOne: async (opts: { where: { team_id: string; project_id: string } }) =>
      projects.find(
        (p) => p.team_id === opts.where.team_id && p.project_id === opts.where.project_id,
      ) ?? null,
  } as unknown as Repository<AtlasProject>;
  const channelRepo = {
    findOne: async (opts: { where: { team_id: string; project_id: string } }) =>
      channels.find(
        (c) => c.team_id === opts.where.team_id && c.project_id === opts.where.project_id,
      ) ?? null,
  } as unknown as Repository<AtlasChannel>;
  return new ProjectRoutingService(projectRepo, channelRepo);
}

const project = (over: Partial<AtlasProject>): AtlasProject =>
  ({ team_id: 'T1', project_id: 'web', git_url: 'https://github.com/acme/web.git', ...over }) as AtlasProject;
const channel = (over: Partial<AtlasChannel>): AtlasChannel =>
  ({ id: 'c1', team_id: 'T1', project_id: 'web', display_name: 'web' }) as AtlasChannel;

describe('ProjectRoutingService', () => {
  it('routes a github repo across teams by normalized git_url → project + 1:1 channel', async () => {
    const s = svc([project({})], [channel({})]);
    const route = await s.routeGithubRepo('Acme/Web'); // case-insensitive
    expect(route).not.toBeNull();
    expect(route!.teamId).toBe('T1');
    expect(route!.projectId).toBe('web');
    expect(route!.channel.id).toBe('c1');
  });

  it('returns null for an unregistered github repo', async () => {
    const s = svc([project({})], [channel({})]);
    expect(await s.routeGithubRepo('other/repo')).toBeNull();
  });

  it('treats a project with no 1:1 channel as unroutable', async () => {
    const s = svc([project({})], []); // no channel
    expect(await s.routeGithubRepo('acme/web')).toBeNull();
  });

  it('routes a generic webhook by (teamId, projectId)', async () => {
    const s = svc([project({})], [channel({})]);
    const route = await s.routeProjectId('T1', 'web');
    expect(route!.projectId).toBe('web');
    expect(await s.routeProjectId('T1', 'nope')).toBeNull();
  });
});
