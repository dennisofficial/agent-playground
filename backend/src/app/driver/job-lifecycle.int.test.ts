/**
 * R2 GATE — Thread lifecycle + per-thread sandbox/worktree API (durable worktree + disposable
 * container model).
 *
 * Proves (against live Postgres, fake git + a fake docker-ish sandbox provider):
 *  1. `createJob` persists the `jobs` row + an `attached` `job_sandboxes` row with
 *     the thread's FEATURE branch cut at create (branch-at-create) + a container attached.
 *  2. `ensureContainer` reuses the live container, bumps `last_active_at`, and reports `wasReset` from
 *     the provider's `warm` flag (cold re-attach ⇒ reset).
 *  3. `reapIdle` detaches the CONTAINER of an idle thread (worktree survives) → `detached`; a subsequent
 *     `ensureContainer` re-attaches it.
 *  4. `closeJob` tears down the container + removes the worktree → `closed` (idempotent).
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvService } from '../../_core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { BrainGateway } from '../brain-gateway';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { LocalGitService } from '../git';
import { CredentialResolver } from '../onboarding';
import { TenantCredentialStore } from '../onboarding';
import { GithubPrService } from '../git';
import { JobDependencyService } from '../job-deps';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ActiveTurnEntity,
  DecisionRecordEntity,
  TranscriptMessageEntity,
  OrgCredentialsEntity,
  OrganizationEntity,
  RepoEntity,
  ThreadEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  ToolExecutionEntity,
} from '../persistence/entities';
import { SANDBOX_PROVIDER, SandboxActivityRegistry } from '../sandbox';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { SkillUpdaterService } from '../skills/skill-updater.service';
import {
  DRIVER_REPO,
  type DriverRepoResolver,
  JobLifecycleService,
  WorktreeProvisioner,
  type ResolvedRepo,
} from '.';
import { ProvisioningNotReadyError } from './job-lifecycle.service';

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

  async ensureRepo(input: {
    repoId: string;
    gitUrl: string;
    defaultBranch?: string;
    token?: string;
  }): Promise<ProjectRepo> {
    return {
      repoId: input.repoId,
      gitUrl: input.gitUrl,
      defaultBranch: input.defaultBranch ?? 'main',
      repoPath: `/tmp/r2-gate-fake-repos/${input.repoId}`,
    };
  }

  async createBaseWorktree(
    repo: ProjectRepo,
    jobId: string,
  ): Promise<FeatureSandbox> {
    const path = `${repo.repoPath}/.worktrees/thread-${jobId}`;
    this.worktreesByThreadId.set(jobId, path);
    return {
      repoId: repo.repoId,
      branch: FAKE_BASE_BRANCH,
      worktreePath: path,
      gitUrl: repo.gitUrl,
    };
  }

  async switchBranch(
    sandbox: FeatureSandbox,
    _repo: ProjectRepo,
    featureBranch: string,
  ): Promise<FeatureSandbox> {
    this.branches.push(featureBranch);
    return { ...sandbox, branch: featureBranch };
  }

  async refExists(_repoPath: string, ref: string): Promise<boolean> {
    const branch = ref.replace(/^refs\/heads\//, '');
    return branch === FAKE_BASE_BRANCH || this.branches.includes(branch);
  }

  // Provision-path no-ops (no real git/cache/submodules/index in the fake). The fake repo never carries
  // a `.gitmodules`, so it always takes the plain-worktree path (never the full-clone submodule path).
  async hasSubmodules(): Promise<boolean> {
    return false;
  }

  async createBaseClone(
    repo: ProjectRepo,
    jobId: string,
  ): Promise<FeatureSandbox> {
    return this.createBaseWorktree(repo, jobId);
  }

  async ensureSubmodules(): Promise<void> {}
  async isIgnored(): Promise<boolean> {
    return true;
  }

  async removeSandbox(_repo: ProjectRepo, worktreePath: string): Promise<void> {
    this.removedWorktrees.push(worktreePath);
  }

  async createFeatureSandbox(
    repo: ProjectRepo,
    branch: string,
  ): Promise<FeatureSandbox> {
    return {
      repoId: repo.repoId,
      branch,
      worktreePath: `${repo.repoPath}/.worktrees/${branch}`,
      gitUrl: repo.gitUrl,
    };
  }
}

/** A fake docker-ish SANDBOX_PROVIDER: attaches a stable container id + a configurable `warm` flag. */
class FakeSandboxProvider {
  warm = true;
  attachCount = 0;
  readonly tornDown: string[] = [];
  async attach({
    sandbox,
    jobId,
  }: {
    sandbox: FeatureSandbox;
    orgId: string;
    jobId?: string;
  }): Promise<FeatureSandbox> {
    this.attachCount++;
    return {
      ...sandbox,
      containerId: `fake-c-${jobId ?? sandbox.branch}`,
      warm: this.warm,
    };
  }
  async teardown(sandbox: FeatureSandbox): Promise<void> {
    if (sandbox.containerId) this.tornDown.push(sandbox.containerId);
  }
  /**
   * Reclaim by deterministic identity — models the docker manager resolving the container by NAME even
   * when no `container_id` is known (post-restart). Records the stable id `attach` would have used, so
   * teardown is observable regardless of whether the row still carries a `container_id`.
   */
  async teardownByIdentity({
    sandbox,
    jobId,
  }: {
    sandbox: FeatureSandbox;
    orgId: string;
    jobId?: string;
  }): Promise<void> {
    this.tornDown.push(`fake-c-${jobId ?? sandbox.branch}`);
  }
  /** Real temp root so the deep-delete host-dir cleanup is observable (created per test run). */
  readonly stateRoot = mkdtempSync(join(tmpdir(), 'atlas-jl-state-'));
  contextDirHost(orgId: string, jobId: string): string {
    return join(this.stateRoot, 'contexts', orgId, jobId);
  }
  playgroundDirHost(orgId: string, jobId: string): string {
    return join(this.stateRoot, 'playgrounds', orgId, jobId);
  }
  /** Keyed only by jobId, mirroring the real port's `brainTranscriptProjectsDir` signature. */
  brainTranscriptProjectsDir(jobId: string): string | null {
    return join(this.stateRoot, 'transcripts', jobId);
  }
}

// ── Module bootstrap ──────────────────────────────────────────────────────────────────────────────

let mod: TestingModule;
let threadLifecycle: JobLifecycleService;
let sandboxes: Repository<JobSandboxEntity>;
let jobs: Repository<JobEntity>;
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
          JobEntity,
          JobSandboxEntity,
          OrgCredentialsEntity,
          TranscriptMessageEntity,
          ThreadEntity,
          DecisionRecordEntity,
          InboundMessageEntity,
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
          presence: async () => ({
            hasAnthropic: false,
            hasGithub: false,
            engineAuthSet: false,
          }),
          get: async () => undefined,
        },
      },
      {
        provide: CredentialResolver,
        useValue: {
          anthropicKey: async () => undefined,
          openaiKey: async () => undefined,
          githubToken: async () => undefined,
          hostGithubToken: async () => undefined,
          engineAuth: async () => ({ secret: 'test-secret' }),
        },
      },
      {
        provide: GithubPrService,
        useValue: {
          getRepo: async () => null,
          openPullRequest: async () => ({ url: '', existing: false }),
          getPullState: async () => 'open',
        },
      },
      {
        provide: SkillUpdaterService,
        useValue: { reconcileOrgAsync: () => undefined },
      },
      {
        provide: BrainGateway,
        useValue: {
          wakeForProvisioningFailure: vi.fn().mockResolvedValue(undefined),
          openPrAtShip: vi.fn(),
          notifyThreadHalted: vi.fn(),
        },
      },
      {
        provide: DRIVER_REPO,
        useValue: {
          resolve: async (): Promise<ResolvedRepo> => {
            throw new Error('not used in this gate');
          },
        },
      },
      {
        // The provisioner delegates to the fake SANDBOX_PROVIDER so attach/warm behavior is unchanged;
        // hydration is a no-op here (no `.atlas/worktree.json` in the fake worktrees).
        provide: WorktreeProvisioner,
        useValue: {
          provisionAndAttach: async ({
            sandbox,
            orgId,
            jobId,
          }: {
            sandbox: FeatureSandbox;
            orgId: string;
            jobId?: string;
          }) => ({
            sandbox: await provider.attach({ sandbox, orgId, jobId }),
            hydrationSig: 'int-sig',
          }),
        },
      },
      {
        provide: JobDependencyService,
        useValue: {
          onBlockerResolved: vi.fn().mockResolvedValue(undefined),
        },
      },
      {
        provide: TurnRegistry,
        useValue: { failRunningForJob: vi.fn().mockResolvedValue(0) },
      },
      {
        provide: BrainGateway,
        useValue: {
          wakeForProvisioningFailure: vi.fn().mockResolvedValue(undefined),
        },
      },
      JobLifecycleService,
    ],
  }).compile();

  threadLifecycle = mod.get(JobLifecycleService);
  sandboxes = mod.get(getRepositoryToken(JobSandboxEntity, DB_CONNECTION));
  jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
  ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await ds.query(
    `
    INSERT INTO organizations (id, name, slug, status)
    VALUES ($1, $2, $3, 'active')
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `,
    [FAKE_TEAM_ID, 'R2 Gate Org', `r2-gate-org`],
  );

  // Surrogate uuid id is DB-generated; capture it for the (org_id, slug)-unique repo.
  const repoRows = await ds.query(
    `
    INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
    VALUES ($1, $2, $3, $4, $5, NULL, true)
    ON CONFLICT (org_id, slug) DO UPDATE
      SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
    RETURNING id
  `,
    [
      FAKE_TEAM_ID,
      FAKE_PROJECT_SLUG,
      'R2 Gate Repo',
      FAKE_REPO_URL,
      FAKE_BASE_BRANCH,
    ],
  );
  repoId = repoRows[0].id;
});

async function create(displayName = 'Gate thread') {
  return threadLifecycle.createJob({
    orgId: FAKE_TEAM_ID,
    repoId,
    baseBranch: FAKE_BASE_BRANCH,
    displayName,
  });
}

/** Insert a BARE thread row (no sandbox) — the live web/event create paths' shape, before first turn. */
async function createBareThread(): Promise<string> {
  const row = await jobs.save(
    jobs.create({
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

/** Insert one `transcript_messages` row (with its owning `thread_groups`/`threads` parents) at an
 *  explicit `created_at`, so `archiveInactiveJobs`'s `MAX(transcript_messages.created_at)` eligibility
 *  query has real activity to anchor on. */
async function seedTranscriptMessageAt(
  jobId: string,
  createdAt: Date,
): Promise<void> {
  const [threadGroup] = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
    [jobId, FAKE_TEAM_ID],
  );
  const [thread] = await ds.query(
    `INSERT INTO threads (job_id, org_id, thread_group_id, ordinal, brief, role) VALUES ($1, $2, $3, 10, 'b', 'builder') RETURNING id`,
    [jobId, FAKE_TEAM_ID, threadGroup.id],
  );
  await ds.query(
    `INSERT INTO transcript_messages (job_id, thread_id, author, author_id, text, created_at) VALUES ($1, $2, 'U', 'u', 'hi', $3)`,
    [jobId, thread.id, createdAt],
  );
}

// ── GATE tests ───────────────────────────────────────────────────────────────────────────────────

describe('R2 gate — JobLifecycleService (live Postgres + fakes)', () => {
  it('createJob persists an attached sandbox with the feature branch cut at create', async () => {
    const result = await create('Add dark mode');

    expect(result.jobId).toBeTruthy();
    expect(result.worktreePath).toContain(`thread-${result.jobId}`);

    const row = await sandboxes.findOneOrFail({
      where: { id: result.threadSandboxId },
    });
    expect(row.lifecycle).toBe('attached');
    expect(row.container_id).toBe(`fake-c-${result.jobId}`);
    expect(row.last_active_at).not.toBeNull();
    // The branch lives on the THREAD now (single owner — sandbox is pure infra).
    const thread = await jobs.findOneOrFail({ where: { id: result.jobId } });
    expect(thread.base_branch).toBe(FAKE_BASE_BRANCH);
    expect(thread.feature_branch).toBe(`feature/${result.jobId.slice(0, 8)}`);
    expect(fakeGit.branches).toContain(thread.feature_branch);
  });

  it('ensureContainer reuses the live container and reports wasReset from the provider warm flag', async () => {
    const { jobId } = await create();

    provider.warm = true; // reuse warm
    const warm = await threadLifecycle.ensureContainer(jobId, FAKE_TEAM_ID);
    expect(warm).not.toBeNull();
    expect(warm!.wasReset).toBe(false);
    expect(warm!.sandbox.branch).toBe(`feature/${jobId.slice(0, 8)}`);

    provider.warm = false; // simulate a cold re-attach
    const cold = await threadLifecycle.ensureContainer(jobId, FAKE_TEAM_ID);
    expect(cold!.wasReset).toBe(true);

    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('attached');
  });

  it('reapIdle detaches an idle container (worktree survives); ensureContainer re-attaches it', async () => {
    const { jobId } = await create();
    // Age the row well past the default idle TTL.
    await sandboxes.update({ job_id: jobId }, { last_active_at: new Date(0) });

    const reaped = await threadLifecycle.reapIdle();
    expect(reaped).toBeGreaterThanOrEqual(1);

    const detached = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);

    // The next turn re-attaches against the surviving worktree.
    const reattached = await threadLifecycle.ensureContainer(
      jobId,
      FAKE_TEAM_ID,
    );
    expect(reattached).not.toBeNull();
    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('attached');
    expect(row.container_id).toBe(`fake-c-${jobId}`);
  });

  it('closeJob tears down the container + worktree and marks the row closed (idempotent)', async () => {
    const { jobId, worktreePath } = await create();

    await threadLifecycle.closeJob(jobId, FAKE_TEAM_ID);
    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('closed');
    expect(row.container_id).toBeNull();
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);
    expect(fakeGit.removedWorktrees).toContain(worktreePath);

    // Idempotent: a second close is a no-op and ensureContainer returns null for a closed thread.
    await threadLifecycle.closeJob(jobId, FAKE_TEAM_ID);
    expect(
      await threadLifecycle.ensureContainer(jobId, FAKE_TEAM_ID),
    ).toBeNull();
  });

  it('closeJob reclaims the container by NAME even after a boot reconcile nulled container_id (leak fix)', async () => {
    const { jobId } = await create();

    // Simulate a process restart: reconcileOnBoot nulls container_id while the real container keeps
    // running. Pre-fix, closeJob's `if (row.container_id)` guard then skipped teardown → permanent leak.
    await threadLifecycle.reconcileOnBoot();
    const detached = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();

    // reconcileOnBoot is a pure DB update (no provider call), so nothing has been torn down yet.
    expect(provider.tornDown).toHaveLength(0);

    await threadLifecycle.closeJob(jobId, FAKE_TEAM_ID);

    // The container is reclaimed by its deterministic identity DESPITE the null container_id — no orphan.
    expect(provider.tornDown).toContain(`fake-c-${jobId}`);
    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('closed');
  });

  it('deleteJobDeep tears down the sandbox AND sweeps every child row (no orphans)', async () => {
    const { jobId } = await create();

    // Seed one child row in every table that references the thread; deleting the thread must remove all
    // of them via the FK ON DELETE CASCADE (RestoreReferentialIntegrity migration) — zero orphans.
    const [threadGroup] = await ds.query(
      `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
      [jobId, FAKE_TEAM_ID],
    );
    const [thread] = await ds.query(
      `INSERT INTO threads (job_id, org_id, thread_group_id, ordinal, brief, role) VALUES ($1, $2, $3, 10, 'b', 'builder') RETURNING id`,
      [jobId, FAKE_TEAM_ID, threadGroup.id],
    );
    await ds.query(
      `INSERT INTO transcript_messages (job_id, thread_id, author, author_id, text) VALUES ($1, $2, 'U', 'u', 'hi')`,
      [jobId, thread.id],
    );
    await ds.query(
      `INSERT INTO decision_records (org_id, repo_id, job_id, overview) VALUES ($1, $2, $3, 'o')`,
      [FAKE_TEAM_ID, repoId, jobId],
    );
    await ds.query(
      `INSERT INTO inbound_messages (org_id, repo_id, kind, type, trust, body, job_id) VALUES ($1, $2, 'chat', 'user', 'trusted', 'b', $3)`,
      [FAKE_TEAM_ID, repoId, jobId],
    );

    await threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID);

    const count = async (table: string, col = 'job_id') =>
      Number(
        (
          await ds.query(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${col} = $1`,
            [jobId],
          )
        )[0].count,
      );
    expect(await count('jobs', 'id')).toBe(0);
    expect(await count('transcript_messages')).toBe(0);
    expect(await count('threads')).toBe(0);
    expect(await count('thread_groups')).toBe(0);
    expect(await count('decision_records')).toBe(0);
    expect(await count('inbound_messages')).toBe(0);
    expect(await count('job_sandboxes')).toBe(0);
  });

  it('deleteJobDeep removes durable host-side scratch dirs and redundant session JSONL', async () => {
    const { jobId } = await create();

    // Simulate the durable, out-of-worktree scratch dirs a live job would accumulate.
    const playground = provider.playgroundDirHost(FAKE_TEAM_ID, jobId);
    const context = provider.contextDirHost(FAKE_TEAM_ID, jobId);
    const transcriptDir = provider.brainTranscriptProjectsDir(jobId)!;
    for (const dir of [playground, context, transcriptDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'junk.txt'), 'x');
    }
    expect(existsSync(playground)).toBe(true);
    expect(existsSync(context)).toBe(true);
    expect(existsSync(transcriptDir)).toBe(true);

    await threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID);

    expect(existsSync(playground)).toBe(false);
    expect(existsSync(context)).toBe(false);
    expect(existsSync(transcriptDir)).toBe(false);
  });

  it('claimDeleteJob is single-flight: flips status→deleting once, then returns false', async () => {
    const { jobId } = await create();

    const first = await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID);
    expect(first).toBe(true);
    expect((await jobs.findOneOrFail({ where: { id: jobId } })).status).toBe(
      'deleting',
    );

    // A second concurrent claim matches 0 rows (status is already `deleting`) — the guard that stops two
    // DELETE requests from interleaving into the cascade-then-resurrect FK crash.
    expect(await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID)).toBe(
      false,
    );
    // A claim on a job that never existed also returns false (no row to flip).
    expect(
      await threadLifecycle.claimDeleteJob(randomUUID(), FAKE_TEAM_ID),
    ).toBe(false);
  });

  it('a second deleteJobDeep on an already-gone job is a no-op and does not throw (FK-crash regression)', async () => {
    const { jobId } = await create();

    await threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID);
    expect(await jobs.findOne({ where: { id: jobId } })).toBeNull();

    // Pre-fix, closeJob's `sandboxes.save(row)` would INSERT the cascade-deleted sandbox back and violate
    // fk_job_sandboxes_job_id_jobs. It must now be a clean no-op.
    await expect(
      threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID),
    ).resolves.toBeUndefined();
  });

  it('reconcileDeletingJobs finishes a job stranded in `deleting`', async () => {
    const { jobId } = await create();
    // Simulate a crash after the claim committed but before teardown ran.
    await jobs.update({ id: jobId }, { status: 'deleting' });

    const swept = await threadLifecycle.reconcileDeletingJobs();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await jobs.findOne({ where: { id: jobId } })).toBeNull();
    expect(await sandboxes.findOne({ where: { job_id: jobId } })).toBeNull();
  });

  // ── archive (in-place terminal lifecycle: reclaim filesystem, KEEP row + transcript + /context) ────

  it('claimArchiveJob is single-flight: flips status→archived + stamps archived_at once, then returns false', async () => {
    const { jobId } = await create();

    const first = await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);
    expect(first).toBe(true);
    const row = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();

    // A second concurrent claim matches 0 rows (status is already `archived`) — single-flight, same shape
    // as `claimDeleteJob`.
    expect(await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID)).toBe(
      false,
    );
    expect(
      await threadLifecycle.claimArchiveJob(randomUUID(), FAKE_TEAM_ID),
    ).toBe(false);
  });

  it('claimArchiveJob does not steal a job already claimed for hard delete', async () => {
    const { jobId } = await create();

    expect(await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID)).toBe(
      true,
    );
    expect(await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID)).toBe(
      false,
    );
    expect((await jobs.findOneOrFail({ where: { id: jobId } })).status).toBe(
      'deleting',
    );
  });

  it('archiveJobDeep reclaims the container + worktree and drops /playground + the on-disk session JSONL, but KEEPS the jobs row, /context, and transcript', async () => {
    const { jobId, worktreePath } = await create();
    await seedTranscriptMessageAt(jobId, new Date());

    const playground = provider.playgroundDirHost(FAKE_TEAM_ID, jobId);
    const context = provider.contextDirHost(FAKE_TEAM_ID, jobId);
    const transcriptDir = provider.brainTranscriptProjectsDir(jobId)!;
    for (const dir of [playground, context, transcriptDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'junk.txt'), 'x');
    }

    await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);
    await threadLifecycle.archiveJobDeep(jobId, FAKE_TEAM_ID);

    // Physical reclaim: container torn down, worktree removed, /playground + the redundant on-disk
    // session JSONL dropped.
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);
    expect(fakeGit.removedWorktrees).toContain(worktreePath);
    expect(existsSync(playground)).toBe(false);
    expect(existsSync(transcriptDir)).toBe(false);
    const sandboxRow = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(sandboxRow.lifecycle).toBe('closed');

    // Kept: the jobs row, /context (decision d2), and the transcript row.
    expect(existsSync(context)).toBe(true);
    const jobRow = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(jobRow.status).toBe('archived');
    expect(
      Number(
        (
          await ds.query(
            `SELECT COUNT(*) AS count FROM transcript_messages WHERE job_id = $1`,
            [jobId],
          )
        )[0].count,
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('archiveInactiveJobs archives a merged/closed job idle past the TTL, anchored on last transcript activity (not jobs.updated_at)', async () => {
    // A generous TTL + fixed, widely-separated timestamp offsets (rather than a tight TTL raced against a
    // short sleep) keep this deterministic regardless of how long the sequential setup below actually takes.
    process.env.ARCHIVE_INACTIVITY_TTL_MS = '5000';
    try {
      // Eligible: merged, last message well before the cutoff.
      const eligible = await create('Idle merged job');
      await seedTranscriptMessageAt(
        eligible.jobId,
        new Date(Date.now() - 10_000),
      );
      await jobs.update({ id: eligible.jobId }, { pr_state: 'merged' });

      // Ineligible: merged but ACTIVE (last message recent, well inside the 5s TTL).
      const active = await create('Active merged job');
      await seedTranscriptMessageAt(active.jobId, new Date());
      await jobs.update({ id: active.jobId }, { pr_state: 'merged' });

      // Ineligible: idle transcript but PR still open (not merged/closed).
      const open = await create('Idle open-PR job');
      await seedTranscriptMessageAt(open.jobId, new Date(Date.now() - 10_000));
      await jobs.update({ id: open.jobId }, { pr_state: 'open' });

      // Ineligible: merged/closed but ZERO transcript rows — MAX() is NULL, which fails `<` (safe default).
      const noTranscript = await create('No-transcript merged job');
      await jobs.update({ id: noTranscript.jobId }, { pr_state: 'closed' });

      // Ineligible: already claimed for hard delete. The archive sweep must not convert a hard-delete drain
      // into a retained archived row, even if the PR is terminal and the transcript is idle.
      const deleting = await create('Deleting merged job');
      await seedTranscriptMessageAt(
        deleting.jobId,
        new Date(Date.now() - 10_000),
      );
      await jobs.update(
        { id: deleting.jobId },
        { status: 'deleting', pr_state: 'merged' },
      );

      // Not an exact count: this file never truncates between cases/runs, so earlier eligible rows may
      // still be sitting around. Assert the count includes ours and check each job's own outcome below.
      const archivedCount = await threadLifecycle.archiveInactiveJobs();
      expect(archivedCount).toBeGreaterThanOrEqual(1);

      const statusOf = async (jobId: string) =>
        (await jobs.findOneOrFail({ where: { id: jobId } })).status;
      expect(await statusOf(eligible.jobId)).toBe('archived');
      expect(await statusOf(active.jobId)).not.toBe('archived');
      expect(await statusOf(open.jobId)).not.toBe('archived');
      expect(await statusOf(noTranscript.jobId)).not.toBe('archived');
      expect(await statusOf(deleting.jobId)).toBe('deleting');
    } finally {
      delete process.env.ARCHIVE_INACTIVITY_TTL_MS;
    }
  });

  it('reconcileArchivedSandboxes retries the reclaim for an archived job whose sandbox is not yet closed', async () => {
    const { jobId, worktreePath } = await create();
    // Simulate a crash between claimArchiveJob committing and archiveJobDeep's reclaim completing: status
    // is `archived` but the sandbox row is still `attached`.
    await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);

    const retried = await threadLifecycle.reconcileArchivedSandboxes();
    expect(retried).toBeGreaterThanOrEqual(1);

    expect(fakeGit.removedWorktrees).toContain(worktreePath);
    const sandboxRow = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(sandboxRow.lifecycle).toBe('closed');

    // Already-closed archived jobs are left alone (nothing left to retry).
    expect(await threadLifecycle.reconcileArchivedSandboxes()).toBe(0);
  });

  it('reconcileOnBoot marks non-closed rows detached', async () => {
    const { jobId } = await create();
    await threadLifecycle.reconcileOnBoot();
    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('detached');
    expect(row.container_id).toBeNull();
  });

  it('findSandbox returns the persisted sandbox, and null for an unknown thread', async () => {
    const { jobId } = await create();
    const found = await threadLifecycle.findSandbox(jobId, FAKE_TEAM_ID);
    expect(found).not.toBeNull();
    expect(found!.branch).toBe(`feature/${jobId.slice(0, 8)}`);

    expect(
      await threadLifecycle.findSandbox(randomUUID(), FAKE_TEAM_ID),
    ).toBeNull();
  });

  it('findSandbox returns null for a closed sandbox row so archived reads do not touch reclaimed worktrees', async () => {
    const { jobId } = await create();
    await sandboxes.update({ job_id: jobId }, { lifecycle: 'closed' });

    await expect(
      threadLifecycle.findSandbox(jobId, FAKE_TEAM_ID),
    ).resolves.toBeNull();
  });

  // ── ensureProvisioned — lazy first-turn provisioning (the conversation prerequisite) ───────────────

  it('ensureProvisioned provisions a complete sandbox for a BARE thread row', async () => {
    const jobId = await createBareThread();
    const row = await threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID);
    expect(row).not.toBeNull();
    expect(row!.lifecycle).toBe('attached');
    expect(row!.worktree_path).toBeTruthy();
    const thread = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(thread.feature_branch).toBe(`feature/${jobId.slice(0, 8)}`);
  });

  it('ensureProvisioned is idempotent — a second call returns the same row, no re-provision', async () => {
    const jobId = await createBareThread();
    const first = await threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID);
    const attaches = provider.attachCount;
    const second = await threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID);
    expect(second!.id).toBe(first!.id);
    expect(provider.attachCount).toBe(attaches);
  });

  it('ensureProvisioned serializes concurrent first turns into ONE provision (no double row)', async () => {
    const jobId = await createBareThread();
    provider.attachCount = 0;
    const [a, b] = await Promise.all([
      threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID),
      threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID),
    ]);
    expect(a!.id).toBe(b!.id);
    expect(provider.attachCount).toBe(1);
    expect(await sandboxes.find({ where: { job_id: jobId } })).toHaveLength(1);
  });

  it('ensureProvisioned RECOVERS an incomplete row (failed provision: empty worktree / no branch)', async () => {
    const jobId = await createBareThread();
    // Simulate a failed provision: a detached row with empty worktree + no feature branch on the thread.
    await sandboxes.save(
      sandboxes.create({
        org_id: FAKE_TEAM_ID,
        job_id: jobId,
        repo_id: repoId,
        worktree_path: '',
        container_id: null,
        lifecycle: 'detached',
      }),
    );
    const row = await threadLifecycle.ensureProvisioned(jobId, FAKE_TEAM_ID);
    expect(row!.lifecycle).toBe('attached');
    expect(row!.worktree_path).toBeTruthy();
    const thread = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(thread.feature_branch).toBeTruthy();
    // The stale row was replaced — exactly one sandbox row remains.
    expect(await sandboxes.find({ where: { job_id: jobId } })).toHaveLength(1);
  });

  it('ensureProvisioned throws ProvisioningNotReadyError when the repo is not access_ok (no provider call)', async () => {
    const [nr] = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'not-ready-repo', 'NR', 'https://github.com/x/nr.git', 'main', NULL, false)
       ON CONFLICT (org_id, slug) DO UPDATE SET access_ok = false RETURNING id`,
      [FAKE_TEAM_ID],
    );
    const thread = await jobs.save(
      jobs.create({
        org_id: FAKE_TEAM_ID,
        repo_id: nr.id,
        origin: 'control',
        surface_thread_ref: null,
        base_branch: 'main',
      }),
    );
    const before = provider.attachCount;
    await expect(
      threadLifecycle.ensureProvisioned(thread.id, FAKE_TEAM_ID),
    ).rejects.toBeInstanceOf(ProvisioningNotReadyError);
    expect(provider.attachCount).toBe(before);
  });
});

// ── Durable-delivery hygiene gate: detachContainer really finalizes `active_turns` ──────────────────
//
// Root cause of the "operator message never goes through while the sandbox comes back online" bug: a
// container torn down out-of-band (idle-reap / reset / LRU) left its thread's `running` `active_turns`
// row behind for up to ~90-120s, so the durable-delivery pump's liveness check (`runningBrainTurn`) saw
// a "live" turn that had no engine behind it and steered a message into a dead stream. The fix wires
// `detachContainer` to `TurnRegistry.failRunningForJob`. The rest of this file stubs `TurnRegistry`
// entirely (its own module-scope tests don't touch it), so this gate uses the REAL service against real
// Postgres — the stub can't prove the wiring or the DELETE query's scoping are actually correct.
describe('R2 gate — detachContainer finalizes active_turns (real TurnRegistry, live Postgres)', () => {
  let hygieneMod: TestingModule;
  let hygieneLifecycle: JobLifecycleService;
  let hygieneSandboxes: Repository<JobSandboxEntity>;
  let hygieneJobs: Repository<JobEntity>;
  let activeTurns: Repository<ActiveTurnEntity>;
  let hygieneDs: DataSource;
  let hygieneFakeGit: FakeGitService;
  let hygieneProvider: FakeSandboxProvider;
  let hygieneRepoId: string;

  beforeEach(async () => {
    hygieneFakeGit = new FakeGitService();
    hygieneProvider = new FakeSandboxProvider();

    hygieneMod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(
          [
            OrganizationEntity,
            RepoEntity,
            JobEntity,
            JobSandboxEntity,
            OrgCredentialsEntity,
            TranscriptMessageEntity,
            ThreadEntity,
            DecisionRecordEntity,
            InboundMessageEntity,
            ActiveTurnEntity,
            ToolExecutionEntity,
          ],
          DB_CONNECTION,
        ),
      ],
      providers: [
        {
          provide: EnvService,
          useValue: { get: (k: string) => process.env[k] },
        },
        { provide: LocalGitService, useValue: hygieneFakeGit },
        { provide: SANDBOX_PROVIDER, useValue: hygieneProvider },
        SandboxActivityRegistry,
        {
          provide: TenantCredentialStore,
          useValue: {
            presence: async () => ({
              hasAnthropic: false,
              hasGithub: false,
              engineAuthSet: false,
            }),
            get: async () => undefined,
          },
        },
        {
          provide: CredentialResolver,
          useValue: {
            anthropicKey: async () => undefined,
            openaiKey: async () => undefined,
            githubToken: async () => undefined,
            hostGithubToken: async () => undefined,
            engineAuth: async () => ({ secret: 'test-secret' }),
          },
        },
        {
          provide: GithubPrService,
          useValue: {
            getRepo: async () => null,
            openPullRequest: async () => ({ url: '', existing: false }),
            getPullState: async () => 'open',
          },
        },
        {
          provide: SkillUpdaterService,
          useValue: { reconcileOrgAsync: () => undefined },
        },
        {
          provide: BrainGateway,
          useValue: {
            wakeForProvisioningFailure: vi.fn().mockResolvedValue(undefined),
            openPrAtShip: vi.fn(),
            notifyThreadHalted: vi.fn(),
          },
        },
        {
          provide: DRIVER_REPO,
          useValue: {
            resolve: async (): Promise<ResolvedRepo> => {
              throw new Error('not used in this gate');
            },
          },
        },
        {
          provide: WorktreeProvisioner,
          useValue: {
            provisionAndAttach: async ({
              sandbox,
              orgId,
              jobId,
            }: {
              sandbox: FeatureSandbox;
              orgId: string;
              jobId?: string;
            }) => ({
              sandbox: await hygieneProvider.attach({ sandbox, orgId, jobId }),
              hydrationSig: 'int-sig',
            }),
          },
        },
        {
          provide: JobDependencyService,
          useValue: {
            onBlockerResolved: vi.fn().mockResolvedValue(undefined),
          },
        },
        TurnRegistry, // the REAL service — this gate's whole point
        {
          provide: BrainGateway,
          useValue: {
            wakeForProvisioningFailure: vi.fn().mockResolvedValue(undefined),
          },
        },
        JobLifecycleService,
      ],
    }).compile();

    hygieneLifecycle = hygieneMod.get(JobLifecycleService);
    hygieneSandboxes = hygieneMod.get(
      getRepositoryToken(JobSandboxEntity, DB_CONNECTION),
    );
    hygieneJobs = hygieneMod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    activeTurns = hygieneMod.get(
      getRepositoryToken(ActiveTurnEntity, DB_CONNECTION),
    );
    hygieneDs = hygieneMod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await hygieneDs.query(
      `
      INSERT INTO organizations (id, name, slug, status)
      VALUES ($1, $2, $3, 'active')
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `,
      [FAKE_TEAM_ID, 'R2 Gate Org', 'r2-gate-org'],
    );

    const repoRows = await hygieneDs.query(
      `
      INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
      VALUES ($1, $2, $3, $4, $5, NULL, true)
      ON CONFLICT (org_id, slug) DO UPDATE
        SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
      RETURNING id
    `,
      [
        FAKE_TEAM_ID,
        FAKE_PROJECT_SLUG,
        'R2 Gate Repo',
        FAKE_REPO_URL,
        FAKE_BASE_BRANCH,
      ],
    );
    hygieneRepoId = repoRows[0].id;
  });

  afterEach(async () => {
    await hygieneMod.close();
  });

  /** A minimal, real `active_turns` row — the shape `TurnRegistry.register` itself would insert. */
  async function seedRunningTurn(jobId: string, turnId: string): Promise<void> {
    await activeTurns.save(
      activeTurns.create({
        turn_id: turnId,
        job_id: jobId,
        org_id: FAKE_TEAM_ID,
        channel: hygieneRepoId,
        lane: 'main',
        kind: 'brain',
        container_id: `fake-c-${jobId}`,
        status: 'running',
        events_last_id: '0-0',
      }),
    );
  }

  it('reapIdle on a container with a lingering RUNNING brain turn deletes that active_turns row', async () => {
    const { jobId } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate thread',
    });
    // Simulate: a brain turn was live when this container died out-of-band (the exact scenario that
    // let a steered operator message vanish — see the module doc comment above).
    const turnId = randomUUID();
    await seedRunningTurn(jobId, turnId);
    await hygieneSandboxes.update(
      { job_id: jobId },
      { last_active_at: new Date(0) },
    ); // past idle TTL

    const reaped = await hygieneLifecycle.reapIdle();
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = await activeTurns.findOne({ where: { turn_id: turnId } });
    expect(row).toBeNull(); // gone — the pump's liveness check can no longer see a phantom "live" turn
  });

  it('scopes the finalize to THIS job only — a running turn on an unrelated job survives', async () => {
    const { jobId: jobA } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate thread A',
    });
    const { jobId: jobB } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate thread B',
    });
    const turnA = randomUUID();
    const turnB = randomUUID();
    await seedRunningTurn(jobA, turnA);
    await seedRunningTurn(jobB, turnB);
    // Only job A goes idle.
    await hygieneSandboxes.update(
      { job_id: jobA },
      { last_active_at: new Date(0) },
    );
    await hygieneSandboxes.update(
      { job_id: jobB },
      { last_active_at: new Date() },
    );

    await hygieneLifecycle.reapIdle();

    expect(await activeTurns.findOne({ where: { turn_id: turnA } })).toBeNull();
    expect(
      await activeTurns.findOne({ where: { turn_id: turnB } }),
    ).not.toBeNull();
  });

  it('an on-demand resetContainer (the reset_sandbox tool) also finalizes the running turn', async () => {
    const { jobId } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate reset thread',
    });
    const turnId = randomUUID();
    await seedRunningTurn(jobId, turnId);

    const out = await hygieneLifecycle.resetContainer(jobId, FAKE_TEAM_ID);
    expect(out).toEqual({ reset: true });

    expect(
      await activeTurns.findOne({ where: { turn_id: turnId } }),
    ).toBeNull();
  });

  it('a thread with NO running turn reaps cleanly (failRunningForJob is a real no-op, not an error)', async () => {
    const { jobId } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate quiet thread',
    });
    await hygieneSandboxes.update(
      { job_id: jobId },
      { last_active_at: new Date(0) },
    );

    await expect(hygieneLifecycle.reapIdle()).resolves.toBeGreaterThanOrEqual(
      1,
    );
    const row = await hygieneSandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(row.lifecycle).toBe('detached');
  });
});
