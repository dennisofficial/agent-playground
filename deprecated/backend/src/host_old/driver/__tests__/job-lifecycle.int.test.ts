import { EnvService } from '@core/config/env/env.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { BrainGateway } from '../../brain-gateway/brain-gateway.service';
import { GithubPrService } from '../../git/github-pr.service';
import type { FeatureSandbox, ProjectRepo } from '../../git/local-git.service';
import { LocalGitService } from '../../git/local-git.service';
import { JobDependencyService } from '../../job-deps/job-dependency.service';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { TenantCredentialStore } from '../../onboarding/tenant-credential.store';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  ActiveTurnEntity,
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  JobSandboxEntity,
  OrgCredentialsEntity,
  OrganizationEntity,
  RepoEntity,
  ThreadEntity,
  ToolExecutionEntity,
  TranscriptMessageEntity,
} from '../../persistence/entities';
import { SandboxActivityRegistry } from '../../sandbox/sandbox-activity.registry';
import { SANDBOX_PROVIDER } from '../../sandbox/sandbox-provider.port';
import { TurnRegistry } from '../../sandbox/turn-registry.service';
import { SkillUpdaterService } from '../../skills/skill-updater.service';
import { JobLifecycleService, ProvisioningNotReadyError } from '../job-lifecycle.service';
import { DRIVER_REPO, type ResolvedRepo } from '../repo-resolver';
import { WorktreeProvisioner } from '../worktree-provisioner.service';

import { ENTITIES } from '../../persistence/entities';

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

const FAKE_PROJECT_SLUG = 'r2-gate-proj';
const FAKE_TEAM_ID = '11111111-1111-4111-8111-111111111111'; // sentinel org uuid
const FAKE_REPO_URL = 'https://github.com/atlas-r2-gate/sample.git';
const FAKE_BASE_BRANCH = 'main';

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

  async createBaseWorktree(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
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

  async hasSubmodules(): Promise<boolean> {
    return false;
  }

  async createBaseClone(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return this.createBaseWorktree(repo, jobId);
  }

  async ensureSubmodules(): Promise<void> {}
  async isIgnored(): Promise<boolean> {
    return true;
  }

  async removeSandbox(_repo: ProjectRepo, worktreePath: string): Promise<void> {
    this.removedWorktrees.push(worktreePath);
  }

  async createFeatureSandbox(repo: ProjectRepo, branch: string): Promise<FeatureSandbox> {
    return {
      repoId: repo.repoId,
      branch,
      worktreePath: `${repo.repoPath}/.worktrees/${branch}`,
      gitUrl: repo.gitUrl,
    };
  }
}

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
  readonly stateRoot = mkdtempSync(join(tmpdir(), 'atlas-jl-state-'));
  contextDirHost(orgId: string, jobId: string): string {
    return join(this.stateRoot, 'contexts', orgId, jobId);
  }
  playgroundDirHost(orgId: string, jobId: string): string {
    return join(this.stateRoot, 'playgrounds', orgId, jobId);
  }
  draftUploadsDirHost(orgId: string, jobId: string, userId: string): string {
    return join(this.stateRoot, 'draft-uploads', orgId, jobId, userId);
  }
  brainTranscriptProjectsDir(jobId: string): string | null {
    return join(this.stateRoot, 'transcripts', jobId);
  }
}

let mod: TestingModule;
let threadLifecycle: JobLifecycleService;
let sandboxes: Repository<JobSandboxEntity>;
let jobs: Repository<JobEntity>;
let ds: DataSource;
let fakeGit: FakeGitService;
let provider: FakeSandboxProvider;
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

  const repoRows = await ds.query(
    `
    INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
    VALUES ($1, $2, $3, $4, $5, NULL, true)
    ON CONFLICT (org_id, slug) DO UPDATE
      SET git_url = EXCLUDED.git_url, default_branch = EXCLUDED.default_branch
    RETURNING id
  `,
    [FAKE_TEAM_ID, FAKE_PROJECT_SLUG, 'R2 Gate Repo', FAKE_REPO_URL, FAKE_BASE_BRANCH],
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

async function seedTranscriptMessageAt(jobId: string, createdAt: Date): Promise<void> {
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
    await sandboxes.update({ job_id: jobId }, { last_active_at: new Date(0) });

    const reaped = await threadLifecycle.reapIdle();
    expect(reaped).toBeGreaterThanOrEqual(1);

    const detached = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();
    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);

    const reattached = await threadLifecycle.ensureContainer(jobId, FAKE_TEAM_ID);
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

    await threadLifecycle.closeJob(jobId, FAKE_TEAM_ID);
    expect(await threadLifecycle.ensureContainer(jobId, FAKE_TEAM_ID)).toBeNull();
  });

  it('closeJob reclaims the container by NAME even after a boot reconcile nulled container_id (leak fix)', async () => {
    const { jobId } = await create();

    await threadLifecycle.reconcileOnBoot();
    const detached = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(detached.lifecycle).toBe('detached');
    expect(detached.container_id).toBeNull();

    expect(provider.tornDown).toHaveLength(0);

    await threadLifecycle.closeJob(jobId, FAKE_TEAM_ID);

    expect(provider.tornDown).toContain(`fake-c-${jobId}`);
    const row = await sandboxes.findOneOrFail({ where: { job_id: jobId } });
    expect(row.lifecycle).toBe('closed');
  });

  it('deleteJobDeep tears down the sandbox AND sweeps every child row (no orphans)', async () => {
    const { jobId } = await create();

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
        (await ds.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${col} = $1`, [jobId]))[0]
          .count,
      );
    expect(await count('jobs', 'id')).toBe(0);
    expect(await count('transcript_messages')).toBe(0);
    expect(await count('threads')).toBe(0);
    expect(await count('thread_groups')).toBe(0);
    expect(await count('decision_records')).toBe(0);
    expect(await count('inbound_messages')).toBe(0);
    expect(await count('job_sandboxes')).toBe(0);
  });

  it('deleteJobDeep removes durable host-side scratch dirs (/playground, /context, draft uploads) and redundant session JSONL', async () => {
    const { jobId } = await create();

    const playground = provider.playgroundDirHost(FAKE_TEAM_ID, jobId);
    const context = provider.contextDirHost(FAKE_TEAM_ID, jobId);
    const draftUpload = provider.draftUploadsDirHost(FAKE_TEAM_ID, jobId, randomUUID());
    const transcriptDir = provider.brainTranscriptProjectsDir(jobId)!;
    for (const dir of [playground, context, draftUpload, transcriptDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'junk.txt'), 'x');
    }
    expect(existsSync(playground)).toBe(true);
    expect(existsSync(context)).toBe(true);
    expect(existsSync(draftUpload)).toBe(true);
    expect(existsSync(transcriptDir)).toBe(true);

    await threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID);

    expect(existsSync(playground)).toBe(false);
    expect(existsSync(context)).toBe(false);
    expect(existsSync(draftUpload)).toBe(false);
    expect(existsSync(transcriptDir)).toBe(false);
  });

  it('claimDeleteJob is single-flight: flips status→deleting once, then returns false', async () => {
    const { jobId } = await create();

    const first = await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID);
    expect(first).toBe(true);
    expect((await jobs.findOneOrFail({ where: { id: jobId } })).status).toBe('deleting');

    expect(await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID)).toBe(false);
    expect(await threadLifecycle.claimDeleteJob(randomUUID(), FAKE_TEAM_ID)).toBe(false);
  });

  it('a second deleteJobDeep on an already-gone job is a no-op and does not throw (FK-crash regression)', async () => {
    const { jobId } = await create();

    await threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID);
    expect(await jobs.findOne({ where: { id: jobId } })).toBeNull();

    await expect(threadLifecycle.deleteJobDeep(jobId, FAKE_TEAM_ID)).resolves.toBeUndefined();
  });

  it('reconcileDeletingJobs finishes a job stranded in `deleting`', async () => {
    const { jobId } = await create();
    await jobs.update({ id: jobId }, { status: 'deleting' });

    const swept = await threadLifecycle.reconcileDeletingJobs();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await jobs.findOne({ where: { id: jobId } })).toBeNull();
    expect(await sandboxes.findOne({ where: { job_id: jobId } })).toBeNull();
  });

  it('claimArchiveJob is single-flight: flips status→archived + stamps archived_at once, then returns false', async () => {
    const { jobId } = await create();

    const first = await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);
    expect(first).toBe(true);
    const row = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();

    expect(await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID)).toBe(false);
    expect(await threadLifecycle.claimArchiveJob(randomUUID(), FAKE_TEAM_ID)).toBe(false);
  });

  it('claimArchiveJob does not steal a job already claimed for hard delete', async () => {
    const { jobId } = await create();

    expect(await threadLifecycle.claimDeleteJob(jobId, FAKE_TEAM_ID)).toBe(true);
    expect(await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID)).toBe(false);
    expect((await jobs.findOneOrFail({ where: { id: jobId } })).status).toBe('deleting');
  });

  it('archiveJobDeep reclaims the container + worktree and drops /playground + draft uploads + the on-disk session JSONL, but KEEPS the jobs row, /context, and transcript', async () => {
    const { jobId, worktreePath } = await create();
    await seedTranscriptMessageAt(jobId, new Date());

    const playground = provider.playgroundDirHost(FAKE_TEAM_ID, jobId);
    const context = provider.contextDirHost(FAKE_TEAM_ID, jobId);
    const draftUpload = provider.draftUploadsDirHost(FAKE_TEAM_ID, jobId, randomUUID());
    const transcriptDir = provider.brainTranscriptProjectsDir(jobId)!;
    for (const dir of [playground, context, draftUpload, transcriptDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'junk.txt'), 'x');
    }

    await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);
    await threadLifecycle.archiveJobDeep(jobId, FAKE_TEAM_ID);

    expect(provider.tornDown.length).toBeGreaterThanOrEqual(1);
    expect(fakeGit.removedWorktrees).toContain(worktreePath);
    expect(existsSync(playground)).toBe(false);
    expect(existsSync(draftUpload)).toBe(false);
    expect(existsSync(transcriptDir)).toBe(false);
    const sandboxRow = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(sandboxRow.lifecycle).toBe('closed');

    expect(existsSync(context)).toBe(true);
    const jobRow = await jobs.findOneOrFail({ where: { id: jobId } });
    expect(jobRow.status).toBe('archived');
    expect(
      Number(
        (
          await ds.query(`SELECT COUNT(*) AS count FROM transcript_messages WHERE job_id = $1`, [
            jobId,
          ])
        )[0].count,
      ),
    ).toBeGreaterThanOrEqual(1);
  });

  it('archiveInactiveJobs archives a merged/closed job idle past the TTL, anchored on last transcript activity (not jobs.updated_at)', async () => {
    process.env.ARCHIVE_INACTIVITY_TTL_MS = '5000';
    try {
      const eligible = await create('Idle merged job');
      await seedTranscriptMessageAt(eligible.jobId, new Date(Date.now() - 10_000));
      await jobs.update({ id: eligible.jobId }, { pr_state: 'merged' });

      const active = await create('Active merged job');
      await seedTranscriptMessageAt(active.jobId, new Date());
      await jobs.update({ id: active.jobId }, { pr_state: 'merged' });

      const open = await create('Idle open-PR job');
      await seedTranscriptMessageAt(open.jobId, new Date(Date.now() - 10_000));
      await jobs.update({ id: open.jobId }, { pr_state: 'open' });

      const noTranscript = await create('No-transcript merged job');
      await jobs.update({ id: noTranscript.jobId }, { pr_state: 'closed' });

      const deleting = await create('Deleting merged job');
      await seedTranscriptMessageAt(deleting.jobId, new Date(Date.now() - 10_000));
      await jobs.update({ id: deleting.jobId }, { status: 'deleting', pr_state: 'merged' });

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
    await threadLifecycle.claimArchiveJob(jobId, FAKE_TEAM_ID);

    const retried = await threadLifecycle.reconcileArchivedSandboxes();
    expect(retried).toBeGreaterThanOrEqual(1);

    expect(fakeGit.removedWorktrees).toContain(worktreePath);
    const sandboxRow = await sandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(sandboxRow.lifecycle).toBe('closed');

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

    expect(await threadLifecycle.findSandbox(randomUUID(), FAKE_TEAM_ID)).toBeNull();
  });

  it('findSandbox returns null for a closed sandbox row so archived reads do not touch reclaimed worktrees', async () => {
    const { jobId } = await create();
    await sandboxes.update({ job_id: jobId }, { lifecycle: 'closed' });

    await expect(threadLifecycle.findSandbox(jobId, FAKE_TEAM_ID)).resolves.toBeNull();
  });

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
    await expect(threadLifecycle.ensureProvisioned(thread.id, FAKE_TEAM_ID)).rejects.toBeInstanceOf(
      ProvisioningNotReadyError,
    );
    expect(provider.attachCount).toBe(before);
  });
});

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
    hygieneSandboxes = hygieneMod.get(getRepositoryToken(JobSandboxEntity, DB_CONNECTION));
    hygieneJobs = hygieneMod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    activeTurns = hygieneMod.get(getRepositoryToken(ActiveTurnEntity, DB_CONNECTION));
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
      [FAKE_TEAM_ID, FAKE_PROJECT_SLUG, 'R2 Gate Repo', FAKE_REPO_URL, FAKE_BASE_BRANCH],
    );
    hygieneRepoId = repoRows[0].id;
  });

  afterEach(async () => {
    await hygieneMod.close();
  });

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
    const turnId = randomUUID();
    await seedRunningTurn(jobId, turnId);
    await hygieneSandboxes.update({ job_id: jobId }, { last_active_at: new Date(0) }); // past idle TTL

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
    await hygieneSandboxes.update({ job_id: jobA }, { last_active_at: new Date(0) });
    await hygieneSandboxes.update({ job_id: jobB }, { last_active_at: new Date() });

    await hygieneLifecycle.reapIdle();

    expect(await activeTurns.findOne({ where: { turn_id: turnA } })).toBeNull();
    expect(await activeTurns.findOne({ where: { turn_id: turnB } })).not.toBeNull();
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

    expect(await activeTurns.findOne({ where: { turn_id: turnId } })).toBeNull();
  });

  it('a thread with NO running turn reaps cleanly (failRunningForJob is a real no-op, not an error)', async () => {
    const { jobId } = await hygieneLifecycle.createJob({
      orgId: FAKE_TEAM_ID,
      repoId: hygieneRepoId,
      baseBranch: FAKE_BASE_BRANCH,
      displayName: 'Hygiene gate quiet thread',
    });
    await hygieneSandboxes.update({ job_id: jobId }, { last_active_at: new Date(0) });

    await expect(hygieneLifecycle.reapIdle()).resolves.toBeGreaterThanOrEqual(1);
    const row = await hygieneSandboxes.findOneOrFail({
      where: { job_id: jobId },
    });
    expect(row.lifecycle).toBe('detached');
  });
});
