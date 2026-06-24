import { describe, expect, it } from 'vitest';
import type { Repository } from 'typeorm';
import type { GithubPrService, RepoInfo } from '../git';
import type { AtlasOrgCredentials, AtlasRepo, Organization } from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OnboardingService } from './onboarding.service';
import type { CredentialPresence, TenantCredentialStore } from './tenant-credential.store';

// ── in-memory fake repositories ───────────────────────────────────────────────────────────────────

function makeOrgs() {
  const map = new Map<string, Organization>();
  map.set('T1', { id: 'T1', name: 'T1', slug: 't1', status: 'onboarding' } as Organization);
  const repo = {
    async findOne({ where }: { where: { id: string } }) {
      return map.get(where.id) ?? null;
    },
    async update({ id }: { id: string }, patch: Partial<Organization>) {
      const prev = map.get(id);
      if (prev) map.set(id, { ...prev, ...patch });
    },
  } as unknown as Repository<Organization>;
  return { repo, map };
}

function makeRepos() {
  const map = new Map<string, AtlasRepo>();
  const k = (o: string, r: string) => `${o}:${r}`;
  const repo = {
    async findOne({ where }: { where: { org_id: string; repo_id?: string; access_ok?: boolean } }) {
      if (where.access_ok !== undefined) {
        for (const v of map.values()) {
          if (v.org_id === where.org_id && v.access_ok === where.access_ok) return v;
        }
        return null;
      }
      return map.get(k(where.org_id, where.repo_id as string)) ?? null;
    },
    async upsert(obj: Partial<AtlasRepo>) {
      const key = k(obj.org_id as string, obj.repo_id as string);
      map.set(key, { ...(map.get(key) ?? {}), ...obj } as AtlasRepo);
    },
    async update({ org_id, repo_id }: { org_id: string; repo_id: string }, patch: Partial<AtlasRepo>) {
      const key = k(org_id, repo_id);
      if (map.has(key)) map.set(key, { ...map.get(key)!, ...patch });
    },
  } as unknown as Repository<AtlasRepo>;
  return { repo, map };
}

function makeOrgCreds(llmValidated = false) {
  const map = new Map<string, AtlasOrgCredentials>();
  if (llmValidated) {
    map.set('T1:*', { org_id: 'T1', scope: '*', llm_validated_at: new Date() } as AtlasOrgCredentials);
  }
  const repo = {
    async findOne({ where }: { where: { org_id: string; scope: string } }) {
      return map.get(`${where.org_id}:${where.scope}`) ?? null;
    },
    async update({ org_id, scope }: { org_id: string; scope: string }, patch: Partial<AtlasOrgCredentials>) {
      const key = `${org_id}:${scope}`;
      map.set(key, { ...(map.get(key) ?? ({ org_id, scope } as AtlasOrgCredentials)), ...patch });
    },
  } as unknown as Repository<AtlasOrgCredentials>;
  return { repo, map };
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
      return { hasAnthropic: false, hasOpenai: false, hasGithub: false, engineAuthSet: false, ...presence };
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

function assemble(
  opts: {
    presence?: Partial<CredentialPresence>;
    creds?: Partial<Record<'anthropic' | 'github', string>>;
    repoInfo?: RepoInfo | null;
    llmValidated?: boolean;
  } = {},
) {
  const orgs = makeOrgs();
  const repos = makeRepos();
  const orgCreds = makeOrgCreds(opts.llmValidated);
  const svc = new OnboardingService(
    orgs.repo,
    repos.repo,
    orgCreds.repo,
    fakeCreds(opts.creds),
    fakeStore(opts.presence),
    fakePr(opts.repoInfo ?? null),
  );
  return { svc, orgs, repos, orgCreds };
}

const REPO = 'https://github.com/acme/web';

describe('OnboardingService', () => {
  describe('connectRepo', () => {
    it('connects a repo (slug from the url) and validates access', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const result = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      expect(result.repoId).toBe('web');
      expect(result.accessOk).toBe(true);
      expect(repos.map.get('T1:web')?.git_url).toBe(REPO);
      expect(repos.map.get('T1:web')?.access_ok).toBe(true);
    });

    it('records access_ok=false when the token cannot reach the repo', async () => {
      const { svc, repos } = assemble({ repoInfo: null }); // no token
      const result = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      expect(result.accessOk).toBe(false);
      expect(repos.map.get('T1:web')?.access_ok).toBe(false);
    });

    it('rejects a non-GitHub url', async () => {
      const { svc } = assemble();
      const result = await svc.connectRepo({ orgId: 'T1', repoUrl: 'not-a-url' });
      expect(result.accessOk).toBe(false);
      expect(result.reason).toContain('not an HTTPS GitHub URL');
    });
  });

  describe('status / nextStep', () => {
    it('reports the derived checklist with missing in order', async () => {
      const { svc } = assemble(); // nothing configured
      const status = await svc.status('T1');
      expect(status.steps).toEqual({
        repoConnected: false,
        llmKey: false,
        engineAuth: false,
        githubPat: false,
      });
      expect(status.missing).toEqual(['repo', 'llm_key', 'engine_auth', 'github_pat']);
      expect(status.lifecycle).toBe('onboarding');
    });

    it('marks repoConnected once a validated repo exists', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      const status = await svc.status('T1');
      expect(status.steps.repoConnected).toBe(true);
      expect(status.missing[0]).toBe('llm_key');
    });

    it('reflects credential presence + validated llm key → complete', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc } = assemble({
        presence: { hasAnthropic: true, hasGithub: true, engineAuthSet: true },
        creds: { github: 'ghp_x' },
        repoInfo: info,
        llmValidated: true,
      });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      const status = await svc.status('T1');
      expect(status.missing).toEqual([]);
      expect(await svc.nextStep('T1')).toBeNull();
    });
  });

  describe('validateRepo', () => {
    it('fails when no token is set', async () => {
      const { svc } = assemble({ repoInfo: null });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      expect((await svc.validateRepo('T1', 'web')).ok).toBe(false);
    });

    it('passes when the repo is reachable', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
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
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc, orgs } = assemble({
        presence: { hasAnthropic: true, hasGithub: true, engineAuthSet: true },
        creds: { github: 'ghp_x' },
        repoInfo: info,
        llmValidated: true,
      });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      const status = await svc.tryActivate('T1');
      expect(status.lifecycle).toBe('active');
      expect(orgs.map.get('T1')?.status).toBe('active');
    });

    it('is a no-op while steps remain', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      expect((await svc.tryActivate('T1')).lifecycle).toBe('onboarding');
    });
  });
});
