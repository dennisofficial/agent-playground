import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ModuleRef } from '@nestjs/core';
import type { Repository } from 'typeorm';
import type { GithubPrService, RepoInfo } from '../git';
import type {
  DecisionRecordEntity,
  OrganizationEntity,
  OrgCredentialsEntity,
  RepoEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import { CredentialResolver } from './credential-resolver.service';
import { OnboardingService } from './onboarding.service';
import type { CredentialPresence, TenantCredentialStore } from './tenant-credential.store';

// ── in-memory fake repositories ───────────────────────────────────────────────────────────────────

function makeOrgs() {
  const map = new Map<string, OrganizationEntity>();
  map.set('T1', { id: 'T1', name: 'T1', slug: 't1', status: 'onboarding' } as OrganizationEntity);
  const repo = {
    async findOne({ where }: { where: { id: string } }) {
      return map.get(where.id) ?? null;
    },
    async update({ id }: { id: string }, patch: Partial<OrganizationEntity>) {
      const prev = map.get(id);
      if (prev) map.set(id, { ...prev, ...patch });
    },
  } as unknown as Repository<OrganizationEntity>;
  return { repo, map };
}

function makeRepos() {
  const map = new Map<string, RepoEntity>(); // keyed by `${org_id}:${slug}`
  const k = (o: string, s: string) => `${o}:${s}`;
  let seq = 0;
  const repo = {
    async findOne({ where }: { where: { id?: string; org_id?: string; slug?: string; access_ok?: boolean } }) {
      if (where.id !== undefined) {
        for (const v of map.values()) {
          // Honor the org scope when both are given (so cross-tenant ids resolve to null → 404).
          if (v.id === where.id && (where.org_id === undefined || v.org_id === where.org_id)) return v;
        }
        return null;
      }
      if (where.access_ok !== undefined) {
        for (const v of map.values()) {
          if (v.org_id === where.org_id && v.access_ok === where.access_ok) return v;
        }
        return null;
      }
      return map.get(k(where.org_id as string, where.slug as string)) ?? null;
    },
    async findOneOrFail({ where }: { where: { id?: string; org_id?: string; slug?: string } }) {
      if (where.id !== undefined) {
        for (const v of map.values()) if (v.id === where.id) return v;
        throw new Error('repo not found');
      }
      const found = map.get(k(where.org_id as string, where.slug as string));
      if (!found) throw new Error('repo not found');
      return found;
    },
    async upsert(obj: Partial<RepoEntity>) {
      const key = k(obj.org_id as string, obj.slug as string);
      const prev = map.get(key);
      map.set(key, { id: prev?.id ?? `repo-${++seq}`, ...(prev ?? {}), ...obj } as RepoEntity);
    },
    async update(
      where: { id?: string; org_id?: string; slug?: string },
      patch: Partial<RepoEntity>,
    ) {
      if (where.id !== undefined) {
        for (const [key, v] of map) if (v.id === where.id) map.set(key, { ...v, ...patch });
        return;
      }
      const key = k(where.org_id as string, where.slug as string);
      if (map.has(key)) map.set(key, { ...map.get(key)!, ...patch });
    },
    async delete(where: { id?: string; org_id?: string }) {
      for (const [key, v] of map) {
        if (
          where.id !== undefined &&
          v.id === where.id &&
          (where.org_id === undefined || v.org_id === where.org_id)
        ) {
          map.delete(key);
        }
      }
    },
    // `ensureWebhooksForActiveRepos` scans all access_ok repos (no org scope) for the leader-promotion backfill.
    async find({ where }: { where: { org_id?: string; access_ok?: boolean } }) {
      return [...map.values()].filter(
        (v) =>
          (where.org_id === undefined || v.org_id === where.org_id) &&
          (where.access_ok === undefined || v.access_ok === where.access_ok),
      );
    },
  } as unknown as Repository<RepoEntity>;
  return { repo, map };
}

/**
 * A minimal in-memory table fake for the child entities `OnboardingService` only counts/deletes
 * (`threads`, `stimuli`, `decision_records`, `thread_sandboxes`). `count` takes `{ where }`; `delete`
 * takes the criteria directly — matching TypeORM's repository surface used in the service.
 */
function makeTable<T extends Record<string, unknown>>(seed: T[] = []) {
  const rows: T[] = [...seed];
  const matches = (r: T, w: Record<string, unknown>) =>
    Object.entries(w).every(([key, val]) => r[key] === val);
  const repo = {
    async count({ where }: { where: Record<string, unknown> }) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async find({ where }: { where: Record<string, unknown>; select?: unknown }) {
      return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async delete(where: Record<string, unknown>) {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], where)) rows.splice(i, 1);
      return { affected: 0 };
    },
  } as unknown as Repository<T>;
  return { repo, rows };
}

function makeOrgCreds(llmValidated = false) {
  const map = new Map<string, OrgCredentialsEntity>();
  if (llmValidated) {
    map.set('T1:*', { org_id: 'T1', scope: '*', llm_validated_at: new Date() } as OrgCredentialsEntity);
  }
  const repo = {
    async findOne({ where }: { where: { org_id: string; scope: string } }) {
      return map.get(`${where.org_id}:${where.scope}`) ?? null;
    },
    async update({ org_id, scope }: { org_id: string; scope: string }, patch: Partial<OrgCredentialsEntity>) {
      const key = `${org_id}:${scope}`;
      map.set(key, { ...(map.get(key) ?? ({ org_id, scope } as OrgCredentialsEntity)), ...patch });
    },
  } as unknown as Repository<OrgCredentialsEntity>;
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
    async hostGithubToken() {
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
        hasCodex: false,
        hasGithubApp: false,
        githubAuthMode: 'pat' as const,
        ...presence,
      };
    },
  } as unknown as TenantCredentialStore;
}

/**
 * Fakes the env accessor `OnboardingService` reads for webhook registration. Defaults to a publicly
 * reachable backend + a secret set, so a test opts INTO the skip paths by overriding a single key.
 */
function fakeEnv(over: Record<string, string | undefined> = {}): EnvService {
  const values: Record<string, string | undefined> = {
    BACKEND_HOST: 'https://api.example.com',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    ...over,
  };
  return { get: (k: string) => values[k] } as unknown as EnvService;
}

function fakePr(
  repoInfo: RepoInfo | null,
  opts: { ensureWebhookOutcome?: 'created' | 'updated' | 'no-scope' | 'error' } = {},
): GithubPrService & { ensureWebhookCalls: number } {
  let ensureWebhookCalls = 0;
  return {
    async getRepo() {
      return repoInfo;
    },
    async ensureWebhook() {
      ensureWebhookCalls++;
      return opts.ensureWebhookOutcome ?? 'created';
    },
    async pruneWebhooksExcept() {
      return 0;
    },
    get ensureWebhookCalls() {
      return ensureWebhookCalls;
    },
  } as unknown as GithubPrService & { ensureWebhookCalls: number };
}

function assemble(
  opts: {
    presence?: Partial<CredentialPresence>;
    creds?: Partial<Record<'anthropic' | 'github', string>>;
    repoInfo?: RepoInfo | null;
    llmValidated?: boolean;
    env?: Record<string, string | undefined>;
    ensureWebhookOutcome?: 'created' | 'updated' | 'no-scope' | 'error';
  } = {},
) {
  const orgs = makeOrgs();
  const repos = makeRepos();
  const orgCreds = makeOrgCreds(opts.llmValidated);
  const threads = makeTable<{ id: string; repo_id: string; org_id: string }>();
  const stimuli = makeTable<{ repo_id: string; org_id: string }>();
  const decisionRecords = makeTable<{ repo_id: string; org_id: string }>();
  const sandboxes = makeTable<{ repo_id: string; org_id: string }>();

  // `disconnectRepo` resolves `JobLifecycleService` lazily via `moduleRef.get(...)`. The fake records
  // each deep-delete AND removes the thread row (mirroring the real teardown) so the drain loop converges.
  const deepDeleted: Array<{ jobId: string; orgId: string }> = [];
  const threadLifecycle = {
    deleteJobDeep: async (jobId: string, orgId: string) => {
      deepDeleted.push({ jobId, orgId });
      await threads.repo.delete({ id: jobId, org_id: orgId });
    },
  };
  const moduleRef = { get: () => threadLifecycle } as unknown as ModuleRef;
  const pr = fakePr(opts.repoInfo ?? null, { ensureWebhookOutcome: opts.ensureWebhookOutcome });

  const svc = new OnboardingService(
    orgs.repo,
    repos.repo,
    orgCreds.repo,
    threads.repo as unknown as Repository<JobEntity>,
    stimuli.repo as unknown as Repository<StimulusEntity>,
    decisionRecords.repo as unknown as Repository<DecisionRecordEntity>,
    sandboxes.repo as unknown as Repository<JobSandboxEntity>,
    fakeCreds(opts.creds),
    fakeStore(opts.presence),
    pr,
    moduleRef,
    fakeEnv(opts.env),
  );
  return { svc, orgs, repos, orgCreds, threads, stimuli, decisionRecords, sandboxes, threadLifecycle, deepDeleted, pr };
}

const REPO = 'https://github.com/acme/web';

describe('OnboardingService', () => {
  describe('connectRepo', () => {
    it('connects a repo (slug from the url) and validates access', async () => {
      const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const result = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      expect(result.slug).toBe('web');
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
        openaiKey: false,
        engineAuth: false,
        githubPat: false,
      });
      expect(status.missing).toEqual(['repo', 'llm_key', 'openai_key', 'engine_auth', 'github_pat']);
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
        presence: { hasAnthropic: true, hasOpenai: true, hasGithub: true, engineAuthSet: true },
        creds: { github: 'ghp_x' },
        repoInfo: info,
        llmValidated: true,
      });
      await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      const status = await svc.status('T1');
      expect(status.missing).toEqual([]);
      expect(await svc.nextStep('T1')).toBeNull();
    });

    it('counts GitHub App access only when app mode is active', async () => {
      const { svc } = assemble({
        presence: { hasGithubApp: true, githubAuthMode: 'app' },
      });
      const status = await svc.status('T1');
      expect(status.steps.githubPat).toBe(true);
    });

    it('does not count a connected GitHub App while PAT mode is active and no PAT is saved', async () => {
      const { svc } = assemble({
        presence: { hasGithubApp: true, githubAuthMode: 'pat' },
      });
      const status = await svc.status('T1');
      expect(status.steps.githubPat).toBe(false);
      expect(status.missing).toContain('github_pat');
    });
  });

  describe('revalidateRepo', () => {
    const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;

    it('re-probes access and persists access_ok + a fresh checked time', async () => {
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      // Simulate access having gone stale, then prove revalidate restores it.
      await repos.repo.update({ id: connected.id }, { access_ok: false, access_checked_at: null });

      const res = await svc.revalidateRepo('T1', connected.id);
      expect(res.accessOk).toBe(true);
      expect(repos.map.get('T1:web')?.access_ok).toBe(true);
      expect(repos.map.get('T1:web')?.access_checked_at).toBeInstanceOf(Date);
    });

    it("404s on a repo id from another org (cross-tenant)", async () => {
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      await expect(svc.revalidateRepo('OTHER', connected.id)).rejects.toThrow(/not found/i);
    });
  });

  describe('updateRepo', () => {
    const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;

    it('updates display name + default branch (metadata only)', async () => {
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });

      const res = await svc.updateRepo('T1', connected.id, { name: 'Web App', defaultBranch: 'develop' });
      expect(res.name).toBe('Web App');
      expect(res.defaultBranch).toBe('develop');
      expect(repos.map.get('T1:web')?.default_branch).toBe('develop');
    });

    it('persists a branch prefix and clears it back to null on empty string', async () => {
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });

      const configured = await svc.updateRepo('T1', connected.id, { branchPrefix: 'feat/' });
      expect(configured.branchPrefix).toBe('feat/');
      expect(repos.map.get('T1:web')?.branch_prefix).toBe('feat/');

      const cleared = await svc.updateRepo('T1', connected.id, { branchPrefix: '' });
      expect(cleared.branchPrefix).toBeNull();
      expect(repos.map.get('T1:web')?.branch_prefix).toBeNull();
    });

    it("404s on a repo id from another org (cross-tenant)", async () => {
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      await expect(svc.updateRepo('OTHER', connected.id, { name: 'x' })).rejects.toThrow(/not found/i);
    });

    it('persists repo-level merge default updates (method + delete-branch)', async () => {
      // The 'squash'/true DB column defaults themselves are real-Postgres behavior (this in-memory fake
      // doesn't model `@Column({ default: ... })`) — covered by the int test's connect-then-read assertion.
      // This exercises the write/read-back path the fake CAN model: `updateRepo` persisting new values.
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });

      const res = await svc.updateRepo('T1', connected.id, {
        defaultAutoMergeMethod: 'rebase',
        defaultAutoMergeDeleteBranch: false,
      });
      expect(res.defaultAutoMergeMethod).toBe('rebase');
      expect(res.defaultAutoMergeDeleteBranch).toBe(false);
      expect(repos.map.get('T1:web')?.default_auto_merge_method).toBe('rebase');
      expect(repos.map.get('T1:web')?.default_auto_merge_delete_branch).toBe(false);
    });
  });

  describe('reonboardRepo (operator-initiated re-onboard)', () => {
    const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;

    it('404s when the repo does not exist', async () => {
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      await expect(svc.reonboardRepo('T1', 'nope')).rejects.toThrow(/not found/i);
    });

    it('rejects when the repo access is not validated', async () => {
      const { svc, repos } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      await repos.repo.update({ id: connected.id }, { access_ok: false });
      await expect(svc.reonboardRepo('T1', connected.id)).rejects.toThrow(/validated/i);
    });

    it('rejects when the org cannot run Atlas yet (missing credentials)', async () => {
      // access_ok repo, but the org has no LLM key / engine auth → not runnable.
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      await expect(svc.reonboardRepo('T1', connected.id)).rejects.toThrow(/finish org setup/i);
    });
  });

  describe('disconnectRepo', () => {
    const info = { fullName: 'acme/web', owner: 'acme', name: 'web' } as RepoInfo;

    it('cascade-deletes the repo’s threads, then disconnects', async () => {
      const { svc, repos, threads, deepDeleted } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      threads.rows.push({ id: 't1', repo_id: connected.id, org_id: 'T1' });
      threads.rows.push({ id: 't2', repo_id: connected.id, org_id: 'T1' });

      const res = await svc.disconnectRepo('T1', connected.id);
      expect(res).toEqual({ ok: true, threadsDeleted: 2 });
      expect(deepDeleted.map((d) => d.jobId).sort()).toEqual(['t1', 't2']);
      expect(deepDeleted.every((d) => d.orgId === 'T1')).toBe(true);
      expect(threads.rows).toHaveLength(0);
      expect(repos.map.get('T1:web')).toBeUndefined();
    });

    it('drains a thread created mid-cascade (no orphan left behind)', async () => {
      const { svc, threads, threadLifecycle } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      threads.rows.push({ id: 't1', repo_id: connected.id, org_id: 'T1' });

      // Simulate a concurrent create: the first deep-delete inserts one more thread row mid-cascade.
      const original = threadLifecycle.deleteJobDeep;
      let injected = false;
      threadLifecycle.deleteJobDeep = async (jobId, orgId) => {
        await original(jobId, orgId);
        if (!injected) {
          injected = true;
          threads.rows.push({ id: 't2', repo_id: connected.id, org_id: 'T1' });
        }
      };

      const res = await svc.disconnectRepo('T1', connected.id);
      expect(res.threadsDeleted).toBe(2);
      expect(threads.rows).toHaveLength(0); // the straggler was drained too
    });

    it('disconnects an empty repo and sweeps its repo-scoped rows', async () => {
      const { svc, repos, stimuli, decisionRecords, sandboxes } = assemble({
        creds: { github: 'ghp_x' },
        repoInfo: info,
      });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      stimuli.rows.push({ repo_id: connected.id, org_id: 'T1' });
      decisionRecords.rows.push({ repo_id: connected.id, org_id: 'T1' });
      sandboxes.rows.push({ repo_id: connected.id, org_id: 'T1' });

      const res = await svc.disconnectRepo('T1', connected.id);
      expect(res).toEqual({ ok: true, threadsDeleted: 0 });
      expect(repos.map.get('T1:web')).toBeUndefined();
      expect(stimuli.rows).toHaveLength(0);
      expect(decisionRecords.rows).toHaveLength(0);
      expect(sandboxes.rows).toHaveLength(0);
    });

    it("404s on a repo id from another org (cross-tenant)", async () => {
      const { svc } = assemble({ creds: { github: 'ghp_x' }, repoInfo: info });
      const connected = await svc.connectRepo({ orgId: 'T1', repoUrl: REPO });
      await expect(svc.disconnectRepo('OTHER', connected.id)).rejects.toThrow(/not found/i);
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
        presence: { hasAnthropic: true, hasOpenai: true, hasGithub: true, engineAuthSet: true },
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

  describe('ensureWebhooksForActiveRepos / ensureRepoWebhook', () => {
    // Seeds an access_ok repo directly (bypassing connectRepo, whose own fire-and-forget webhook call
    // would otherwise race with — and double-count — the assertions below).
    function seedActiveRepo(repos: ReturnType<typeof makeRepos>) {
      const row = {
        id: 'repo-1',
        org_id: 'T1',
        slug: 'web',
        name: 'web',
        git_url: REPO,
        default_branch: 'main',
        access_ok: true,
      } as RepoEntity;
      repos.map.set('T1:web', row);
      return row;
    }

    it("skips (no ensureWebhook call, no warning) when BACKEND_HOST isn't publicly reachable", async () => {
      const { svc, repos, pr } = assemble({
        creds: { github: 'ghp_x' },
        env: { BACKEND_HOST: 'http://localhost:4002' },
      });
      seedActiveRepo(repos);
      await svc.ensureWebhooksForActiveRepos();
      expect(pr.ensureWebhookCalls).toBe(0);
      expect(repos.map.get('T1:web')?.webhook_warning).toBeFalsy();
    });

    it('skips when GITHUB_WEBHOOK_SECRET is unset', async () => {
      const { svc, repos, pr } = assemble({
        creds: { github: 'ghp_x' },
        env: { GITHUB_WEBHOOK_SECRET: undefined },
      });
      seedActiveRepo(repos);
      await expect(svc.ensureWebhooksForActiveRepos()).resolves.toBeUndefined();
      expect(pr.ensureWebhookCalls).toBe(0);
    });

    it('skips when the org has no GitHub token', async () => {
      const { svc, repos, pr } = assemble({});
      seedActiveRepo(repos);
      await expect(svc.ensureWebhooksForActiveRepos()).resolves.toBeUndefined();
      expect(pr.ensureWebhookCalls).toBe(0);
    });

    it('writes a no-scope warning when ensureWebhook reports the PAT lacks admin:repo_hook', async () => {
      const { svc, repos } = assemble({
        creds: { github: 'ghp_x' },
        ensureWebhookOutcome: 'no-scope',
      });
      seedActiveRepo(repos);
      await svc.ensureWebhooksForActiveRepos();
      expect(repos.map.get('T1:web')?.webhook_warning).toContain('admin:repo_hook');
    });

    it('clears the warning when both hooks register cleanly', async () => {
      const { svc, repos } = assemble({
        creds: { github: 'ghp_x' },
        ensureWebhookOutcome: 'updated',
      });
      const row = seedActiveRepo(repos);
      row.webhook_warning = 'stale warning from a prior run';
      await svc.ensureWebhooksForActiveRepos();
      expect(repos.map.get('T1:web')?.webhook_warning).toBeNull();
    });
  });
});
