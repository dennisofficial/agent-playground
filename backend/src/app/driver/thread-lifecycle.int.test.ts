/**
 * R2 GATE — Thread lifecycle + per-thread sandbox/worktree API (durable worktree + disposable
 * container model).
 *
 * Proves (against live Postgres, fake git + a fake docker-ish sandbox provider):
 *  1. `createThread` persists the `threads` row + an `attached` `thread_sandboxes` row with
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
import { TenantCredentialStore } from '../onboarding';
import { GithubPrService } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  OrgCredentialsEntity,
  OrganizationEntity,
  PhaseEntity,
  RepoEntity,
  SectionEntity,
  StimulusEntity,
  ThreadEntity,
  ThreadSandboxEntity,
} from '../persistence/entities';
import { SANDBOX_PROVIDER, SandboxActivityRegistry } from '../sandbox';
import { DRIVER_REPO, type DriverRepoResolver, ThreadLifecycleService, type ResolvedRepo } from '.';
import { ProvisioningNotReadyError } from './thread-lifecycle.service';

import { ENTITIES } from '../persistence/entities';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

// ── Fake collaborators ────────────────────────────────────────────────────────────────────────────

const FAKE_PROJECT_SLUG = 'r2-gate-proj';
const FAKE_TEAM_ID = '11111111-1111-4111-8111-111111111111'; // sentinel org uuid
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
  attachCount = 0;
  readonly tornDown: string[] = [];
  async attach({ sandbox, threadId }: { sandbox: FeatureSandbox; orgId: string; threadId?: string }): Promise<FeatureSandbox> {
    this.attachCount++;
    return { ...sandbox, containerId: `fake-c-${threadId ?? sandbox.branch}`, warm: this.warm };
  }
  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (sandbox.containerId) this.tornDown.push(sandbox.containerId);
  }
  /**
   * Reclaim by deterministic identity — models the docker manager resolving the container by NAME even
   * when no `container_id` is known (post-restart). Records the stable id `attach` would have used, so
   * teardown is observable regardless of whether the row still carries a `container_id`.
   */
  async teardownByIdentity({ sandbox, threadId }: { sandbox: FeatureSandbox; orgId: string; threadId?: string }): Promise<void> {
    this.tornDown.push(`fake-c-${threadId ?? sandbox.branch}`);
  }
  contextDirHost(orgId: string, threadId: string): string {
    return `/fake/contexts/${orgId}/${threadId}`;
  }
}

// ── Module bootstrap ──────────────────────────────────────────────────────────────────────────────

let mod: TestingModule;
let threadLifecycle: ThreadLifecycleService;
let sandboxes: Repository<ThreadSandboxEntity>;
let threads: Repository<ThreadEntity>;
let ds: DataSource;
let fakeGit: FakeGitService;
let provider: FakeSandboxProvider;
/** The seeded repo's uuid id (the API + child rows reference this, not the slug). */
let repoId: string;

beforeEach(async () => {
  fakeGit = new FakeGitService();
  provider = new FakeSandboxProvider();

  mod = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot(dbOpts()),
      TypeOrmModule.forFeature(
        [
          OrganizationEntity,
          RepoEntity,
          ThreadEntity,
          ThreadSandboxEntity,
          OrgCredentialsEntity,
          MessageEntity,
          SectionEntity,
          PhaseEntity,
          DecisionRecordEntity,
          StimulusEntity,
        ],
        DB_CONNECTION,
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
      {
        provide: DRIVER_REPO,
        useValue: { resolve: async (): Promise<ResolvedRepo> => { throw new Error('not used in this gate'); } },
      },
      ThreadLifecycleService,
    ],
  }).compile();

  threadLifecycle = mod.get(ThreadLifecycleService);
  sandboxes = mod.get(getRepositoryToken(ThreadSandboxEntity, DB_CONNECTION));
  threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
  ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await ds.query(`
    INSERT INTO organizations (id, name, slug, status)
    VALUES ($1, $2, $3, 'active')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `, [FAKE_TEAM_ID, 'R2 Gate Org', `r2-gate-org`]);

  // Surrogate uuid id is DB-generated; capture it for the (org_id, slug)-unique repo.
  const repoRows = await ds.query(`
    INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
    VALUES ($1, $2, $3, $4, $5, NULL, true)
    ON CONFLICT (org_id, slug) DO UPDATE
      SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
    RETURNING id
  `, [FAKE_TEAM_ID, FAKE_PROJECT_SLUG, 'R2 Gate Repo', FAKE_REPO_URL, FAKE_BASE_BRANCH]);
  repoId = repoRows[0].id;
});

async function create(displayName = 'Gate thread') {
  return threadLifecycle.createThread({
    orgId: FAKE_TEAM_ID,
    repoId,
    baseBranch: FAKE_BASE_BRANCH,
    displayName,
  });
}

/** Insert a BARE thread row (no sandbox) — the live web/event create paths' shape, before first turn. */
async function createBareThread(): Promise<string> {
  const row = await threads.save(
    threads.create({
      org_id: FAKE_TEAM_ID,
      repo_id: repoId,
      origin: 'control',
      surface_thread_ref: null,
      title: 'bare',
      base_branch: FAKE_BASE_BRANCH,
    }),
  );
  return row.id;
}

// ── GATE tests ───────────────────────────────────────────────────────────────────────────────────

describe('R2 gate — ThreadLifecycleService (live Postgres + fakes)', () => {
  it('createThread persists an attached sandbox with the feature branch cut at create', async () => {
    const result = await create('Add dark mode');

    expect(result.threadId).toBeTruthy();
    expect(result.worktreePath).toContain(`thread-${result.threadId}`);

    const row = await sandboxes.findOneOrFail({ where: { id: result.threadSandboxId } });
    expect(row.lifecycle).toBe('attached');
    expect(row.container_id).toBe(`fake-c-${result.threadId}`);
    expect(row.last_active_at).not.toBeNull();
    // The branch lives on the THREAD now (single owner — sandbox is pure infra).
    const thread = await threads.findOneOrFail({ where: { id: result.threadId } });
    expect(thread.base_branch).toBe(FAKE_BASE_BRANCH);
    expect(thread.feature_branch).toBe(`atlas/thread-${result.threadId.slice(0, 8)}`);
    expect(fakeGit.branches).toContain(thread.feature_branch);
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

  it('closeThread reclaims the container by NAME even after a boot reconcile nulled container_id (leak fix)', async () => {
    const { threadId } = await create();

    // Simulate a process restart: reconcileOnBoot nulls container_id while the real container keeps
    // running. Pre-fix, closeThread's `if (row.container_id)` guard then skipped teardown → permanent leak.
    await threadLifecycle.reconcileOnBoot();
    const detached = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();

    // reconcileOnBoot is a pure DB update (no provider call), so nothing has been torn down yet.
    expect(provider.tornDown).toHaveLength(0);

    await threadLifecycle.closeThread(threadId, FAKE_TEAM_ID);

    // The container is reclaimed by its deterministic identity DESPITE the null container_id — no orphan.
    expect(provider.tornDown).toContain(`fake-c-${threadId}`);
    const row = await sandboxes.findOneOrFail({ where: { thread_id: threadId } });
    expect(row.lifecycle).toBe('closed');
  });

  it('deleteThreadDeep tears down the sandbox AND sweeps every child row (no orphans)', async () => {
    const { threadId } = await create();

    // Seed one child row in every table that references the thread; deleting the thread must remove all
    // of them via the FK ON DELETE CASCADE (RestoreReferentialIntegrity migration) — zero orphans.
    await ds.query(`INSERT INTO messages (thread_id, author, author_id, text) VALUES ($1, 'U', 'u', 'hi')`, [threadId]);
    const [section] = await ds.query(
      `INSERT INTO sections (thread_id, org_id, ordinal, brief) VALUES ($1, $2, 10, 'b') RETURNING id`,
      [threadId, FAKE_TEAM_ID],
    );
    await ds.query(
      `INSERT INTO phases (section_id, thread_id, org_id, ordinal, brief) VALUES ($1, $2, $3, 10, 'b')`,
      [section.id, threadId, FAKE_TEAM_ID],
    );
    await ds.query(
      `INSERT INTO decision_records (org_id, repo_id, thread_id, overview) VALUES ($1, $2, $3, 'o')`,
      [FAKE_TEAM_ID, repoId, threadId],
    );
    await ds.query(
      `INSERT INTO stimuli (org_id, repo_id, kind, trust, body, thread_id) VALUES ($1, $2, 'chat', 'trusted', 'b', $3)`,
      [FAKE_TEAM_ID, repoId, threadId],
    );

    await threadLifecycle.deleteThreadDeep(threadId, FAKE_TEAM_ID);

    const count = async (table: string, col = 'thread_id') =>
      Number((await ds.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${col} = $1`, [threadId]))[0].count);
    expect(await count('threads', 'id')).toBe(0);
    expect(await count('messages')).toBe(0);
    expect(await count('sections')).toBe(0);
    expect(await count('phases')).toBe(0);
    expect(await count('decision_records')).toBe(0);
    expect(await count('stimuli')).toBe(0);
    expect(await count('thread_sandboxes')).toBe(0);
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

  // ── ensureProvisioned — lazy first-turn provisioning (the conversation prerequisite) ───────────────

  it('ensureProvisioned provisions a complete sandbox for a BARE thread row', async () => {
    const threadId = await createBareThread();
    const row = await threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID);
    expect(row).not.toBeNull();
    expect(row!.lifecycle).toBe('attached');
    expect(row!.worktree_path).toBeTruthy();
    const thread = await threads.findOneOrFail({ where: { id: threadId } });
    expect(thread.feature_branch).toBe(`atlas/thread-${threadId.slice(0, 8)}`);
  });

  it('ensureProvisioned is idempotent — a second call returns the same row, no re-provision', async () => {
    const threadId = await createBareThread();
    const first = await threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID);
    const attaches = provider.attachCount;
    const second = await threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID);
    expect(second!.id).toBe(first!.id);
    expect(provider.attachCount).toBe(attaches);
  });

  it('ensureProvisioned serializes concurrent first turns into ONE provision (no double row)', async () => {
    const threadId = await createBareThread();
    provider.attachCount = 0;
    const [a, b] = await Promise.all([
      threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID),
      threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(provider.attachCount).toBe(1);
    expect(await sandboxes.find({ where: { thread_id: threadId } })).toHaveLength(1);
  });

  it('ensureProvisioned RECOVERS an incomplete row (failed provision: empty worktree / no branch)', async () => {
    const threadId = await createBareThread();
    // Simulate a failed provision: a detached row with empty worktree + no feature branch on the thread.
    await sandboxes.save(
      sandboxes.create({
        org_id: FAKE_TEAM_ID,
        thread_id: threadId,
        repo_id: repoId,
        worktree_path: '',
        container_id: null,
        lifecycle: 'detached',
      }),
    );
    const row = await threadLifecycle.ensureProvisioned(threadId, FAKE_TEAM_ID);
    expect(row!.lifecycle).toBe('attached');
    expect(row!.worktree_path).toBeTruthy();
    const thread = await threads.findOneOrFail({ where: { id: threadId } });
    expect(thread.feature_branch).toBeTruthy();
    // The stale row was replaced — exactly one sandbox row remains.
    expect(await sandboxes.find({ where: { thread_id: threadId } })).toHaveLength(1);
  });

  it('ensureProvisioned throws ProvisioningNotReadyError when the repo is not access_ok (no provider call)', async () => {
    const [nr] = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'not-ready-repo', 'NR', 'https://github.com/x/nr.git', 'main', NULL, false)
       ON CONFLICT (org_id, slug) DO UPDATE SET access_ok = false RETURNING id`,
      [FAKE_TEAM_ID],
    );
    const thread = await threads.save(
      threads.create({ org_id: FAKE_TEAM_ID, repo_id: nr.id, origin: 'control', surface_thread_ref: null, base_branch: 'main' }),
    );
    const before = provider.attachCount;
    await expect(threadLifecycle.ensureProvisioned(thread.id, FAKE_TEAM_ID)).rejects.toBeInstanceOf(
      ProvisioningNotReadyError,
    );
    expect(provider.attachCount).toBe(before);
  });
});
