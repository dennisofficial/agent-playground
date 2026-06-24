import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { GithubPrService, RepoInfo } from '../git';
import type { AtlasChannel, AtlasRepo, AtlasTeam } from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OnboardingService } from './onboarding.service';
import type { CredentialPresence, TenantCredentialStore } from './tenant-credential.store';

// ── in-memory fake repositories ───────────────────────────────────────────────────────────────────

function makeTeams() {
  const map = new Map<string, AtlasTeam>();
  const repo = {
    async findOne({ where }: { where: { org_id: string } }) {
      return map.get(where.org_id) ?? null;
    },
    async upsert(obj: Partial<AtlasTeam>) {
      const prev = map.get(obj.org_id as string);
      map.set(obj.org_id as string, { ...(prev ?? {}), ...obj } as AtlasTeam);
    },
    async update({ org_id }: { org_id: string }, patch: Partial<AtlasTeam>) {
      const prev = map.get(org_id);
      if (prev) map.set(org_id, { ...prev, ...patch });
    },
  } as unknown as Repository<AtlasTeam>;
  return { repo, map };
}

function makeProjects() {
  const map = new Map<string, AtlasRepo>();
  const k = (t: string, p: string) => `${t}:${p}`;
  const repo = {
    async findOne({ where }: { where: { org_id: string; repo_id: string } }) {
      return map.get(k(where.org_id, where.repo_id)) ?? null;
    },
    async upsert(obj: Partial<AtlasRepo>) {
      map.set(k(obj.org_id as string, obj.repo_id as string), {
        ...(map.get(k(obj.org_id as string, obj.repo_id as string)) ?? {}),
        ...obj,
      } as AtlasRepo);
    },
  } as unknown as Repository<AtlasRepo>;
  return { repo, map };
}

function makeChannels() {
  const rows: AtlasChannel[] = [];
  let seq = 0;
  const repo = {
    async findOne({ where }: { where: { org_id: string; repo_id: string } }) {
      return rows.find((r) => r.org_id === where.org_id && r.repo_id === where.repo_id) ?? null;
    },
    async find({ where }: { where: { org_id: string } }) {
      return rows.filter((r) => r.org_id === where.org_id);
    },
    create(partial: Partial<AtlasChannel>) {
      return { ...partial } as AtlasChannel;
    },
    async save(row: AtlasChannel) {
      if (!row.id) {
        row.id = `ch-${++seq}`;
        rows.push(row);
      }
      return row;
    },
  } as unknown as Repository<AtlasChannel>;
  return { repo, rows };
}

function fakeCreds(over: Partial<Record<'anthropic' | 'github', string>> = {}): CredentialResolver {
  return {
    async anthropicKey() {
      return over.anthropic;
    },
    async githubToken() {
      return over.github;
    },
  } as unknown as CredentialResolver;
}

function fakeStore(presence: Partial<CredentialPresence> = {}): TenantCredentialStore {
  return {
    async presence() {
      return {
        hasAnthropic: false,
        hasOpenai: false,
        hasGithub: false,
        engineAuthSet: false,
        ...presence,
      };
    },
  } as unknown as TenantCredentialStore;
}

function fakePr(repoInfo: RepoInfo | null): GithubPrService {
  return {
    async getRepo() {
      return repoInfo;
    },
  } as unknown as GithubPrService;
}

function assemble(opts: {
  presence?: Partial<CredentialPresence>;
  creds?: Partial<Record<'anthropic' | 'github', string>>;
  repoInfo?: RepoInfo | null;
} = {}) {
  const teams = makeTeams();
  const projects = makeProjects();
  const channels = makeChannels();
  const svc = new OnboardingService(
    teams.repo,
    projects.repo,
    channels.repo,
    fakeCreds(opts.creds),
    fakeStore(opts.presence),
    fakePr(opts.repoInfo ?? null),
  );
  return { svc, teams, projects, channels };
}

const REPO = 'https://github.com/acme/web';

describe('OnboardingService', () => {
  describe('bindChannel', () => {
    it('creates team (onboarding) + project + channel and binds the surface ref', async () => {
      const { svc, teams, projects, channels } = assemble();
      const { channelId } = await svc.bindChannel({
        orgId: 'T1',
        repoId: 'web',
        channelRef: 'C1',
        repoUrl: REPO,
      });
      expect(channelId).toBeTruthy();
      expect(teams.map.get('T1')?.status).toBe('onboarding');
      expect(projects.map.get('T1:web')?.git_url).toBe(REPO);
      expect(channels.rows[0].surface_channel_ref).toBe('C1'); // THE routing fix
    });

    it('activate:true marks the tenant active (test-bridge / admin path)', async () => {
      const { svc, teams } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO, activate: true });
      expect(teams.map.get('T1')?.status).toBe('active');
    });

    it('preserves an existing active team status on re-bind (repo re-point)', async () => {
      const { svc, teams } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO, activate: true });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO + '-2' });
      expect(teams.map.get('T1')?.status).toBe('active'); // not reset to onboarding
    });

    it('re-points an existing channel surface ref (find-or-create, not duplicate)', async () => {
      const { svc, channels } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C2', repoUrl: REPO });
      expect(channels.rows).toHaveLength(1);
      expect(channels.rows[0].surface_channel_ref).toBe('C2');
    });
  });

  describe('status / nextStep', () => {
    it('reports the derived checklist with missing in order', async () => {
      const { svc } = assemble(); // nothing configured
      const status = await svc.status('T1');
      expect(status.steps).toEqual({
        installed: false,
        channelBound: false,
        llmKey: false,
        engineAuth: false,
        githubPat: false,
      });
      expect(status.missing).toEqual(['install', 'bind_channel', 'llm_key', 'engine_auth', 'github_pat']);
      expect(status.lifecycle).toBe('pending');
    });

    it('marks channelBound once a channel + repo exist', async () => {
      const { svc } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      const status = await svc.status('T1');
      expect(status.steps.installed).toBe(true);
      expect(status.steps.channelBound).toBe(true);
      expect(status.missing[0]).toBe('llm_key');
    });

    it('reflects credential presence', async () => {
      const { svc } = assemble({ presence: { hasAnthropic: true, hasGithub: true, engineAuthSet: true } });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      const status = await svc.status('T1');
      expect(status.missing).toEqual([]);
      expect(await svc.nextStep('T1')).toBeNull();
    });
  });

  describe('validateRepo', () => {
    it('fails when no token is set', async () => {
      const { svc } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      expect((await svc.validateRepo('T1', 'web')).ok).toBe(false);
    });

    it('fails when the repo is unreachable (getRepo → null)', async () => {
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: null });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      expect((await svc.validateRepo('T1', 'web')).ok).toBe(false);
    });

    it('passes when the repo is reachable', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      expect((await svc.validateRepo('T1', 'web')).ok).toBe(true);
    });
  });

  describe('validateLlmKey', () => {
    it('fails fast (no network) when no key is set', async () => {
      const { svc } = assemble();
      expect((await svc.validateLlmKey('T1')).ok).toBe(false);
    });
  });

  describe('tryActivate', () => {
    it('flips to active once every step is met', async () => {
      const { svc, teams } = assemble({ presence: { hasAnthropic: true, hasGithub: true, engineAuthSet: true } });
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      const status = await svc.tryActivate('T1');
      expect(status.lifecycle).toBe('active');
      expect(teams.map.get('T1')?.status).toBe('active');
    });

    it('is a no-op while steps remain', async () => {
      const { svc } = assemble();
      await svc.bindChannel({ orgId: 'T1', repoId: 'web', channelRef: 'C1', repoUrl: REPO });
      expect((await svc.tryActivate('T1')).lifecycle).toBe('onboarding');
    });
  });
});
