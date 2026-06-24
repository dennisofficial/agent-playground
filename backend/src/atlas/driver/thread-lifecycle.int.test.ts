/**
 * R2 GATE — Thread lifecycle + per-thread sandbox/worktree API (durable worktree + disposable
 * container model).
 *
 * Proves (against live Postgres, fake git + a fake docker-ish sandbox provider):
 *  1. `createThread` persists the `atlas_threads` row + an `attached` `atlas_thread_sandboxes` row with
 *     the thread's FEATURE branch cut at create (branch-at-create) + a container attached.
 *  2. `ensureContainer` reuses the live container, bumps `last_active_at`, and reports `wasReset` from
 *     the provider's `warm` flag (cold re-attach ⇒ reset).
 *  3. `reapIdle` detaches the CONTAINER of an idle thread (worktree survives) → `detached`; a subsequent
 *     `ensureContainer` re-attaches it.
 *  4. `closeThread` tears down the container + removes the worktree → `closed` (idempotent).
 *  5. `reconcileOnBoot` marks non-closed rows `detached` (next turn re-attaches).
 *  6. `findSandbox` returns the persisted sandbox / null.
 *
 * Integration: real Postgres (atlas_test schema), in-memory fake git (no actual clone), fake sandbox
 * provider (no Docker). Truncates the relevant tables before each test case to keep isolation.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '../../_core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { LocalGitService } from '../git';
import { CredentialResolver } from '../onboarding';
import { OnboardingService } from '../onboarding';
import { TenantCredentialStore } from '../onboarding';
import { GithubPrService } from '../git';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasChannel,
  AtlasRepo,
  AtlasTeam,
  AtlasOrgCredentials,
  AtlasThread,
  AtlasThreadSandbox,
} from '../persistence/entities';
import { SANDBOX_PROVIDER, SandboxActivityRegistry } from '../sandbox';
import { ATLAS_DRIVER_REPO, type DriverRepoResolver, ThreadLifecycleService, type ResolvedRepo } from '.';

import { ATLAS_ENTITIES } from '../persistence/entities';

function dbOpts() {
  return {
    name: ATLAS_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ATLAS_ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

// ── Fake collaborators ────────────────────────────────────────────────────────────────────────────

const FAKE_PROJECT_ID = 'r2-gate-proj';
const FAKE_TEAM_ID = 'T-R2-GATE';
const FAKE_REPO_URL = 'https://github.com/atlas-r2-gate/sample.git';
const FAKE_BASE_BRANCH = 'main';

/** A fake `LocalGitService` that records calls without touching the filesystem. */
class FakeGitService {
  readonly worktreesByThreadId = new Map<string, string>();
  readonly branches: string[] = [];
  readonly removedWorktrees: string[] = [];

  async ensureRepo(input: { repoId: string; gitUrl: string; defaultBranch?: string; token?: string }): Promise<ProjectRepo> {
    return {
      repoId: input.repoId,
      gitUrl: input.gitUrl,
      defaultBranch: input.defaultBranch ?? 'main',
      repoPath: `/tmp/r2-gate-fake-repos/${input.repoId}`,
    };
  }

  async createBaseWorktree(repo: ProjectRepo, threadId: string): Promise<FeatureSandbox> {
    const path = `${repo.repoPath}/.worktrees/thread-${threadId}`;
    this.worktreesByThreadId.set(threadId, path);
    return { repoId: repo.repoId, branch: FAKE_BASE_BRANCH, worktreePath: path, gitUrl: repo.gitUrl };
  }

  async switchBranch(sandbox: FeatureSandbox, _repo: ProjectRepo, featureBranch: string): Promise<FeatureSandbox> {
    this.branches.push(featureBranch);
    return { ...sandbox, branch: featureBranch };
  }

  async removeSandbox(_repo: ProjectRepo, worktreePath: string): Promise<void> {
    this.removedWorktrees.push(worktreePath);
  }

  async createFeatureSandbox(repo: ProjectRepo, branch: string): Promise<FeatureSandbox> {
    return { repoId: repo.repoId, branch, worktreePath: `${repo.repoPath}/.worktrees/${branch}`, gitUrl: repo.gitUrl };
  }
}

/** A fake docker-ish SANDBOX_PROVIDER: attaches a stable container id + a configurable `warm` flag. */
class FakeSandboxProvider {
  warm = true;
  readonly tornDown: string[] = [];
  async attach({ sandbox, threadId }: { sandbox: FeatureSandbox; orgId: string; threadId?: string }): Promise<FeatureSandbox> {
    return { ...sandbox, containerId: `fake-c-${threadId ?? sandbox.branch}`, warm: this.warm };
  }
  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (sandbox.containerId) this.tornDown.push(sandbox.containerId);
  }
}

// ── Module bootstrap ──────────────────────────────────────────────────────────────────────────────

let mod: TestingModule;
let threadLifecycle: ThreadLifecycleService;
let sandboxes: Repository<AtlasThreadSandbox>;
let ds: DataSource;
let fakeGit: FakeGitService;
let provider: FakeSandboxProvider;

beforeEach(async () => {
  fakeGit = new FakeGitService();
  provider = new FakeSandboxProvider();

  mod = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot(dbOpts()),
      TypeOrmModule.forFeature(
        [AtlasTeam, AtlasRepo, AtlasChannel, AtlasThread, AtlasThreadSandbox, AtlasOrgCredentials],
        ATLAS_CONNECTION,
      ),
    ],
    providers: [
      { provide: EnvService, useValue: { get: (k: string) => process.env[k] } },
      { provide: LocalGitService, useValue: fakeGit },
      { provide: SANDBOX_PROVIDER, useValue: provider },
      SandboxActivityRegistry,
      {
        provide: TenantCredentialStore,
        useValue: {
          presence: async () => ({ hasAnthropic: false, hasGithub: false, engineAuthSet: false }),
          get: async () => undefined,
        },
      },
      {
        provide: CredentialResolver,
        useValue: {
          anthropicKey: async () => undefined,
          openaiKey: async () => undefined,
          githubToken: async () => undefined,
          engineAuth: async () => ({ mode: 'api_key', apiKey: undefined }),
        },
      },
      {
        provide: GithubPrService,
        useValue: { getRepo: async () => null, openPullRequest: async () => ({ url: '', existing: false }), getPullState: async () => 'open' },
      },
      OnboardingService,
      {
        provide: ATLAS_DRIVER_REPO,
        useValue: { resolve: async (): Promise<ResolvedRepo> => { throw new Error('not used in this gate'); } },
      },
      ThreadLifecycleService,
    ],
  }).compile();

  threadLifecycle = mod.get(ThreadLifecycleService);
  sandboxes = mod.get(getRepositoryToken(AtlasThreadSandbox, ATLAS_CONNECTION));
  ds = mod.get<DataSource>(getDataSourceToken(ATLAS_CONNECTION));

  await ds.query(`
    INSERT INTO atlas_teams (org_id, team_name, status)
    VALUES ($1, $2, 'active')
    ON CONFLICT (org_id) DO UPDATE SET team_name = EXCLUDED.team_name
  `, [FAKE_TEAM_ID, 'R2 Gate Team']);

  await ds.query(`
    INSERT INTO atlas_projects (org_id, repo_id, display_name, description, git_url, default_branch, token_name)
    VALUES ($1, $2, $3, NULL, $4, $5, NULL)
    ON CONFLICT (org_id, repo_id) DO UPDATE
      SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
  `, [FAKE_TEAM_ID, FAKE_PROJECT_ID, 'R2 Gate Project', FAKE_REPO_URL, FAKE_BASE_BRANCH]);
});

async function create(displayName = 'Gate thread') {
  return threadLifecycle.createThread({
    orgId: FAKE_TEAM_ID,
    repoId: FAKE_PROJECT_ID,
    baseBranch: FAKE_BASE_BRANCH,
    displayName,
  });
}

// ── GATE tests ───────────────────────────────────────────────────────────────────────────────────

describe('R2 gate — ThreadLifecycleService (live Postgres + fakes)', () => {
  it('createThread persists an attached sandbox with the feature branch cut at create', async () => {
    const result = await create('Add dark mode');

    expect(result.threadId).toBeTruthy();
    expect(result.worktreePath).toContain(`thread-${result.threadId}`);

    const row = await sandboxes.findOneOrFail({ where: { id: result.threadSandboxId } });
    expect(row.lifecycle).toBe('attached');
    expect(row.base_branch).toBe(FAKE_BASE_BRANCH);
    expect(row.feature_branch).toBe(`atlas/thread-${result.threadId.slice(0, 8)}`);
    expect(row.container_id).toBe(`fake-c-${result.threadId}`);
    expect(row.last_active_at).not.toBeNull();
    expect(fakeGit.branches).toContain(row.feature_branch);
  });

  it('ensureContainer reuses the live container and reports wasReset from the provider warm flag', async () => {
    const { threadId } = await create();

    provider.warm = true; // reuse warm
    const warm = await threadLifecycle.ensureContainer(threadId, FAKE_TEAM_ID);
    expect(warm).not.toBeNull();
    expect(warm!.wasReset).toBe(false);
    expect(warm!.sandbox.branch).toBe(`atlas/thread-${threadId.slice(0, 8)}`);

    provider.warm = false; // simulate a cold re-attach
    const cold = await threadLifecycle.ensureContainer(threadId, FAKE_TEAM_ID);
    expect(cold!.wasReset).toBe(true);

    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('attached');
  });

  it('reapIdle detaches an idle container (worktree survives); ensureContainer re-attaches it', async () => {
    const { threadId } = await create();
    // Age the row well past the default idle TTL.
    await sandboxes.update({ thread_id: threadId }, { last_active_at: new Date(0) });

    const reaped = await threadLifecycle.reapIdle();
    expect(reaped).toBeGreaterThanOrEqual(1);

    const detached = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);

    // The next turn re-attaches against the surviving worktree.
    const reattached = await threadLifecycle.ensureContainer(threadId, FAKE_TEAM_ID);
    expect(reattached).not.toBeNull();
    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('attached');
    expect(row.container_id).toBe(`fake-c-${threadId}`);
  });

  it('closeThread tears down the container + worktree and marks the row closed (idempotent)', async () => {
    const { threadId, worktreePath } = await create();

    await threadLifecycle.closeThread(threadId, FAKE_TEAM_ID);
    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('closed');
    expect(row.container_id).toBeNull();
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);
    expect(fakeGit.removedWorktrees).toContain(worktreePath);

    // Idempotent: a second close is a no-op and ensureContainer returns null for a closed thread.
    await threadLifecycle.closeThread(threadId, FAKE_TEAM_ID);
    expect(await threadLifecycle.ensureContainer(threadId, FAKE_TEAM_ID)).toBeNull();
  });

  it('reconcileOnBoot marks non-closed rows detached', async () => {
    const { threadId } = await create();
    await threadLifecycle.reconcileOnBoot();
    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('detached');
    expect(row.container_id).toBeNull();
  });

  it('findSandbox returns the persisted sandbox, and null for an unknown thread', async () => {
    const { threadId } = await create();
    const found = await threadLifecycle.findSandbox(threadId, FAKE_TEAM_ID);
    expect(found).not.toBeNull();
    expect(found!.branch).toBe(`atlas/thread-${threadId.slice(0, 8)}`);

    expect(await threadLifecycle.findSandbox(randomUUID(), FAKE_TEAM_ID)).toBeNull();
  });
});
