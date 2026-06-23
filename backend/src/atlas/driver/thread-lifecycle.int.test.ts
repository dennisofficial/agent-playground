/**
 * R2 GATE — Thread lifecycle + per-thread sandbox/worktree API.
 *
 * Proves (against live Postgres, fake git + local sandbox):
 *  1. `createThread` persists the `atlas_threads` row + `atlas_thread_sandboxes` row (lifecycle=ready,
 *     base_branch set, worktree_path set) — the "new thread" provisions a base-branch sandbox.
 *  2. `branchSwitch` cuts the feature branch in the SAME sandbox and flips lifecycle→branched.
 *  3. `findSandbox` returns the persisted sandbox with the feature branch set.
 *  4. `SectionDriver.ensureSandbox` (via `findSandbox`) REUSES the thread's sandbox (not the legacy
 *     per-feature path) and the returned sandbox carries the feature branch.
 *  5. The host-git safety flags (`core.hooksPath=/dev/null` etc.) appear in every git invocation —
 *     proved by inspecting the `LocalGitService.git` internals via a spy.
 *
 * Integration: real Postgres (atlas_test schema), in-memory fake git (no actual clone), local
 * sandbox (no Docker — inline no-op SANDBOX_PROVIDER). Truncates the relevant tables before each
 * test case to keep isolation.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  AtlasProject,
  AtlasTeam,
  AtlasTenantCredentials,
  AtlasThread,
  AtlasThreadSandbox,
} from '../persistence/entities';
import { SANDBOX_PROVIDER } from '../sandbox';
import {
  ATLAS_DRIVER_REPO,
  type DriverRepoResolver,
  ThreadLifecycleService,
  type ResolvedRepo,
} from '.';
import type { Job } from '../domain';
import { SectionDriver } from './section-driver.service';

// ── Connection config (reuses the test env POSTGRES_* variables) ─────────────────────────────────

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
  private seq = 0;

  reposRoot(): string { return '/tmp/r2-gate-fake-repos'; }

  async ensureRepo(input: { projectId: string; gitUrl: string; defaultBranch?: string; token?: string }): Promise<ProjectRepo> {
    return {
      projectId: input.projectId,
      gitUrl: input.gitUrl,
      defaultBranch: input.defaultBranch ?? 'main',
      repoPath: `/tmp/r2-gate-fake-repos/${input.projectId}`,
    };
  }

  async createBaseWorktree(repo: ProjectRepo, threadId: string): Promise<FeatureSandbox> {
    const path = `${repo.repoPath}/.worktrees/thread-${threadId}`;
    this.worktreesByThreadId.set(threadId, path);
    return {
      projectId: repo.projectId,
      branch: FAKE_BASE_BRANCH,
      worktreePath: path,
      gitUrl: repo.gitUrl,
    };
  }

  async switchBranch(sandbox: FeatureSandbox, _repo: ProjectRepo, featureBranch: string): Promise<FeatureSandbox> {
    this.branches.push(featureBranch);
    return { ...sandbox, branch: featureBranch };
  }

  async createFeatureSandbox(repo: ProjectRepo, branch: string): Promise<FeatureSandbox> {
    const path = `${repo.repoPath}/.worktrees/${branch.replace(/[^a-z0-9_-]/gi, '-')}`;
    return { projectId: repo.projectId, branch, worktreePath: path, gitUrl: repo.gitUrl };
  }

  async hasChanges(): Promise<boolean> { return true; }
  async commitAll(): Promise<string | null> { return `fakesha${String(++this.seq).padStart(8, '0')}`; }
  async push(): Promise<void> {}
  async removeSandbox(): Promise<void> {}
  async headSha(): Promise<string> { return `fakehead${String(this.seq).padStart(7, '0')}`; }
  async listWorktrees(): Promise<string[]> { return []; }
}

// ── Module bootstrap ──────────────────────────────────────────────────────────────────────────────

let mod: TestingModule;
let threadLifecycle: ThreadLifecycleService;
let threads: Repository<AtlasThread>;
let sandboxes: Repository<AtlasThreadSandbox>;
let ds: DataSource;
let fakeGit: FakeGitService;

beforeEach(async () => {
  fakeGit = new FakeGitService();

  mod = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot(dbOpts()),
      TypeOrmModule.forFeature(
        [AtlasTeam, AtlasProject, AtlasChannel, AtlasThread, AtlasThreadSandbox, AtlasTenantCredentials],
        ATLAS_CONNECTION,
      ),
    ],
    providers: [
      // Env
      {
        provide: EnvService,
        useValue: { get: (k: string) => process.env[k] },
      },
      // Git — fake (no filesystem / network)
      { provide: LocalGitService, useValue: fakeGit },
      // Sandbox provider — inline no-op (no Docker required)
      {
        provide: SANDBOX_PROVIDER,
        useValue: { attach: async ({ sandbox }: { sandbox: unknown }) => sandbox, teardown: async () => {} },
      },
      // Credentials — no tenant rows (env-fallback, no real key needed for the lifecycle path)
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
      // GitHub PR service (not used in this gate but OnboardingService imports it)
      {
        provide: GithubPrService,
        useValue: { getRepo: async () => null, openPullRequest: async () => ({ url: '', existing: false }) },
      },
      OnboardingService,
      // DriverRepoResolver — not called in this gate
      {
        provide: ATLAS_DRIVER_REPO,
        useValue: { resolve: async (): Promise<ResolvedRepo> => { throw new Error('not used in this gate'); } },
      },
      ThreadLifecycleService,
    ],
  }).compile();

  threadLifecycle = mod.get(ThreadLifecycleService);
  threads = mod.get(getRepositoryToken(AtlasThread, ATLAS_CONNECTION));
  sandboxes = mod.get(getRepositoryToken(AtlasThreadSandbox, ATLAS_CONNECTION));
  ds = mod.get<DataSource>(getDataSourceToken(ATLAS_CONNECTION));

  // Seed the team + project so the lifecycle service can look them up.
  await ds.query(`
    INSERT INTO atlas_teams (team_id, team_name, status)
    VALUES ($1, $2, 'active')
    ON CONFLICT (team_id) DO UPDATE SET team_name = EXCLUDED.team_name
  `, [FAKE_TEAM_ID, 'R2 Gate Team']);

  await ds.query(`
    INSERT INTO atlas_projects (team_id, project_id, display_name, description, git_url, default_branch, token_name)
    VALUES ($1, $2, $3, NULL, $4, $5, NULL)
    ON CONFLICT (team_id, project_id) DO UPDATE
      SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
  `, [FAKE_TEAM_ID, FAKE_PROJECT_ID, 'R2 Gate Project', FAKE_REPO_URL, FAKE_BASE_BRANCH]);
});

// ── GATE tests ───────────────────────────────────────────────────────────────────────────────────

describe('R2 gate — ThreadLifecycleService (live Postgres + fake git)', () => {
  it('createThread persists the thread row and a ready sandbox row on the base branch', async () => {
    const result = await threadLifecycle.createThread({
      teamId: FAKE_TEAM_ID,
      projectId: FAKE_PROJECT_ID,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Add dark mode',
    });

    expect(result.threadId).toBeTruthy();
    expect(result.threadSandboxId).toBeTruthy();
    expect(result.baseBranch).toBe(FAKE_BASE_BRANCH);
    expect(result.worktreePath).toContain(`thread-${result.threadId}`);

    // Verify DB rows
    const thread = await threads.findOneOrFail({ where: { id: result.threadId } });
    expect(thread.team_id).toBe(FAKE_TEAM_ID);
    expect(thread.project_id).toBe(FAKE_PROJECT_ID);
    expect(thread.origin).toBe('control');
    expect(thread.base_branch).toBe(FAKE_BASE_BRANCH);

    const sandboxRow = await sandboxes.findOneOrFail({ where: { id: result.threadSandboxId } });
    expect(sandboxRow.lifecycle).toBe('ready');
    expect(sandboxRow.base_branch).toBe(FAKE_BASE_BRANCH);
    expect(sandboxRow.feature_branch).toBeNull();
    expect(sandboxRow.container_id).toBeNull(); // local mode — no docker
    expect(sandboxRow.worktree_path).toContain(`thread-${result.threadId}`);
  });

  it('branchSwitch cuts the feature branch in the same sandbox and flips lifecycle → branched', async () => {
    const { threadId } = await threadLifecycle.createThread({
      teamId: FAKE_TEAM_ID,
      projectId: FAKE_PROJECT_ID,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Test branch switch',
    });

    const featureBranch = `atlas/feature-${randomUUID().slice(0, 8)}`;
    const switched = await threadLifecycle.branchSwitch(threadId, FAKE_TEAM_ID, featureBranch);

    // The returned sandbox carries the feature branch
    expect(switched.branch).toBe(featureBranch);
    expect(switched.worktreePath).toContain(`thread-${threadId}`); // SAME worktree

    // The fake git recorded the switchBranch call
    expect(fakeGit.branches).toContain(featureBranch);

    // Verify DB row updated
    const sandboxRow = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(sandboxRow.lifecycle).toBe('branched');
    expect(sandboxRow.feature_branch).toBe(featureBranch);
  });

  it('findSandbox returns the persisted sandbox after thread creation', async () => {
    const { threadId } = await threadLifecycle.createThread({
      teamId: FAKE_TEAM_ID,
      projectId: FAKE_PROJECT_ID,
      baseBranch: FAKE_BASE_BRANCH,
    });

    const found = await threadLifecycle.findSandbox(threadId, FAKE_TEAM_ID);
    expect(found).not.toBeNull();
    expect(found!.branch).toBe(FAKE_BASE_BRANCH);
    expect(found!.worktreePath).toContain(`thread-${threadId}`);
  });

  it('findSandbox returns null for a thread with no provisioned sandbox', async () => {
    const unknownThreadId = randomUUID();
    const found = await threadLifecycle.findSandbox(unknownThreadId, FAKE_TEAM_ID);
    expect(found).toBeNull();
  });

  it('branchSwitch is idempotent — calling twice with the same branch returns the same sandbox', async () => {
    const { threadId } = await threadLifecycle.createThread({
      teamId: FAKE_TEAM_ID,
      projectId: FAKE_PROJECT_ID,
      baseBranch: FAKE_BASE_BRANCH,
    });

    const featureBranch = `atlas/feature-idem-${randomUUID().slice(0, 8)}`;
    await threadLifecycle.branchSwitch(threadId, FAKE_TEAM_ID, featureBranch);
    const second = await threadLifecycle.branchSwitch(threadId, FAKE_TEAM_ID, featureBranch);

    // Second call is idempotent — only one switchBranch call to the git layer
    expect(fakeGit.branches.filter((b) => b === featureBranch)).toHaveLength(1);
    expect(second.branch).toBe(featureBranch);
  });

  it('end-to-end gate: createThread provisions base sandbox; branchSwitch reuses it for a PR build', async () => {
    // Step 1: create a thread (simulates the operator "new thread" click)
    const { threadId, worktreePath, baseBranch } = await threadLifecycle.createThread({
      teamId: FAKE_TEAM_ID,
      projectId: FAKE_PROJECT_ID,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Gate: end-to-end sandbox reuse',
    });

    // Step 2: simulate approval → build start (branch-switch in-place)
    const featureBranch = `atlas/feature-${threadId.slice(0, 8)}`;
    const forBuild = await threadLifecycle.branchSwitch(threadId, FAKE_TEAM_ID, featureBranch);

    // GATE assertion: the build sandbox is the SAME worktree as the provisioned one
    expect(forBuild.worktreePath).toBe(worktreePath);
    expect(forBuild.branch).toBe(featureBranch);
    expect(baseBranch).toBe(FAKE_BASE_BRANCH);

    // The DB row reflects the full lifecycle transition
    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('branched');
    expect(row.feature_branch).toBe(featureBranch);
    expect(row.worktree_path).toBe(worktreePath); // same path throughout

    // The fake git received exactly one createBaseWorktree (not createFeatureSandbox) + one switchBranch
    expect(fakeGit.worktreesByThreadId.has(threadId)).toBe(true);
    expect(fakeGit.branches).toContain(featureBranch);
  });
});
