/**
 * deleteOrg cascade GATE — deleting an org must leave ZERO org-scoped rows behind.
 *
 * The schema now carries real FK constraints (the `RestoreReferentialIntegrity` migration): deleting the
 * `organizations` row cascades `ON DELETE CASCADE` down repos/jobs/messages/threads/steps/
 * decision_records/stimuli/job_sandboxes plus the org-direct org_credentials/org_invites/
 * organization_members/memory. `deleteOrg` runs the physical per-thread teardown (container + worktree)
 * then deletes the org row; this proves the combination removes every one of those rows — and ONLY this
 * org's (a sibling org and the shared `users` rows survive; only the membership join cascades).
 *
 * It also guards against a future FK regression: if the cascade chain is ever broken (or a new child
 * table is added without an FK), the orphan assertions below fail.
 *
 * Integration: real Postgres (the dedicated `*_test` DB), an in-memory fake git (no actual clone) and a
 * fake docker-ish sandbox provider (no Docker). The real `JobLifecycleService` runs `deleteJobDeep`
 * per thread; `OrganizationService` resolves it via `ModuleRef` exactly as in production.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '../../_core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import type { FeatureSandbox, ProjectRepo } from '../git';
import { GithubPrService, LocalGitService } from '../git';
import { CredentialResolver, TenantCredentialStore } from '../onboarding';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  ENTITIES,
  MessageEntity,
  OrgInviteEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  StepEntity,
  RepoEntity,
  ThreadEntity,
  StimulusEntity,
  JobEntity,
  JobSandboxEntity,
  UserEntity,
} from '../persistence/entities';
import { SANDBOX_PROVIDER, SandboxActivityRegistry } from '../sandbox';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { DRIVER_REPO, JOB_TEARDOWN, type DriverRepoResolver, type ResolvedRepo, JobLifecycleService, WorktreeProvisioner } from '../driver';
import { SkillUpdaterService } from '../skills/skill-updater.service';
import { TicketService } from '../tickets';
import { OrganizationService } from './organization.service';

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

// ── Fakes (mirror job-lifecycle.int.test.ts — no filesystem, no Docker) ──────────────────────────

class FakeGitService {
  async ensureRepo(input: { repoId: string; gitUrl: string; defaultBranch?: string }): Promise<ProjectRepo> {
    return {
      repoId: input.repoId,
      gitUrl: input.gitUrl,
      defaultBranch: input.defaultBranch ?? 'main',
      repoPath: `/tmp/delete-org-fake-repos/${input.repoId}`,
    };
  }
  async createBaseWorktree(repo: ProjectRepo, jobId: string): Promise<FeatureSandbox> {
    return { repoId: repo.repoId, branch: 'main', worktreePath: `${repo.repoPath}/.worktrees/thread-${jobId}`, gitUrl: repo.gitUrl };
  }
  async switchBranch(sandbox: FeatureSandbox, _repo: ProjectRepo, featureBranch: string): Promise<FeatureSandbox> {
    return { ...sandbox, branch: featureBranch };
  }
  // Provision-path no-ops (no real git/cache/submodules/index in the fake).
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
  async removeSandbox(): Promise<void> {}
}

class FakeSandboxProvider {
  async attach({ sandbox, jobId }: { sandbox: FeatureSandbox; orgId: string; jobId?: string }): Promise<FeatureSandbox> {
    return { ...sandbox, containerId: `fake-c-${jobId ?? sandbox.branch}`, warm: true };
  }
  async teardown(): Promise<void> {}
  async teardownByIdentity(): Promise<void> {}
  contextDirHost(orgId: string, jobId: string): string {
    return `/fake/contexts/${orgId}/${jobId}`;
  }
  playgroundDirHost(orgId: string, jobId: string): string {
    return `/fake/playgrounds/${orgId}/${jobId}`;
  }
}

// ── Sentinel ids — kept distinct from every other int test's tenant so the assertions are isolated. ──

const ORG_ID = '22222222-2222-4222-8222-222222222222'; // the org under deletion
const OTHER_ORG_ID = '33333333-3333-4333-8333-333333333333'; // a sibling that must SURVIVE
const SHARED_USER_ID = '44444444-4444-4444-8444-444444444444'; // a user shared across orgs (never deleted)
const REPO_URL = 'https://github.com/atlas-delete-org/sample.git';
const EMBEDDING = `[${new Array(1536).fill(0).join(',')}]`; // memory.embedding is NOT NULL vector(1536)

let mod: TestingModule;
let orgService: OrganizationService;
let threadLifecycle: JobLifecycleService;
let ds: DataSource;
let repoId: string;
let otherRepoId: string;

/** Delete every row both sentinel orgs own (idempotent — survives a prior failed run). */
async function purge(): Promise<void> {
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    const threadIds: Array<{ id: string }> = await ds.query(`SELECT id FROM jobs WHERE org_id = $1`, [org]);
    const ids = threadIds.map((t) => t.id);
    if (ids.length) {
      await ds.query(`DELETE FROM messages WHERE job_id = ANY($1)`, [ids]);
    }
    for (const table of ['steps', 'threads', 'decision_records', 'stimuli', 'job_sandboxes', 'jobs', 'repos', 'org_credentials', 'org_invites', 'organization_members', 'memory']) {
      await ds.query(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
    }
    await ds.query(`DELETE FROM organizations WHERE id = $1`, [org]);
  }
  await ds.query(`DELETE FROM users WHERE id = $1`, [SHARED_USER_ID]);
}

/** Seed one org + one connected repo; return the repo's surrogate uuid id. */
async function seedOrgWithRepo(orgId: string, slug: string): Promise<string> {
  await ds.query(`INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')`, [orgId, `Org ${slug}`, slug]);
  const rows = await ds.query(
    `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok) VALUES ($1, $2, $3, $4, 'main', true) RETURNING id`,
    [orgId, `${slug}-repo`, `Repo ${slug}`, REPO_URL],
  );
  return rows[0].id;
}

/** Seed one row in every child/org-scoped table for `jobId` under (`orgId`, `repoId`). */
async function seedThreadChildren(orgId: string, repoIdArg: string, jobId: string): Promise<void> {
  await ds.query(`INSERT INTO messages (job_id, author, author_id, text) VALUES ($1, 'U', 'u', 'hi')`, [jobId]);
  const [thread] = await ds.query(
    `INSERT INTO threads (job_id, org_id, ordinal, brief, kind) VALUES ($1, $2, 10, 'b', 'builder') RETURNING id`,
    [jobId, orgId],
  );
  await ds.query(`INSERT INTO steps (thread_id, job_id, org_id, ordinal, brief) VALUES ($1, $2, $3, 10, 'b')`, [thread.id, jobId, orgId]);
  await ds.query(`INSERT INTO decision_records (org_id, repo_id, job_id, overview) VALUES ($1, $2, $3, 'o')`, [orgId, repoIdArg, jobId]);
  await ds.query(`INSERT INTO stimuli (org_id, repo_id, kind, trust, body, job_id) VALUES ($1, $2, 'chat', 'trusted', 'b', $3)`, [orgId, repoIdArg, jobId]);
}

/** Seed the org-DIRECT rows (no thread): credentials, an invite, a membership, memory, a parked event. */
async function seedOrgDirect(orgId: string, repoIdArg: string, inviteToken: string, dedupeKey: string): Promise<void> {
  await ds.query(`INSERT INTO org_credentials (org_id, scope) VALUES ($1, '*')`, [orgId]);
  await ds.query(`INSERT INTO org_invites (token, org_id, email, role) VALUES ($1, $2, 'x@y.com', 'member')`, [inviteToken, orgId]);
  await ds.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [orgId, SHARED_USER_ID]);
  await ds.query(`INSERT INTO memory (fact, embedding, org_id, scope) VALUES ('f', $1::vector, $2, $3)`, [EMBEDDING, orgId, `team:${orgId}`]);
  // A stimulus parked on the org/repo BEFORE any thread existed (job_id NULL) — orphaned unless swept.
  await ds.query(`INSERT INTO stimuli (org_id, repo_id, kind, trust, body, source, dedupe_key) VALUES ($1, $2, 'event', 'untrusted', 'b', 'github', $3)`, [orgId, repoIdArg, dedupeKey]);
}

const countWhere = async (table: string, col: string, val: string): Promise<number> =>
  Number((await ds.query(`SELECT COUNT(*)::int AS c FROM ${table} WHERE ${col} = $1`, [val]))[0].c);

beforeEach(async () => {
  mod = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot(dbOpts()),
      TypeOrmModule.forFeature(
        [
          OrganizationEntity,
          OrganizationMemberEntity,
          OrgInviteEntity,
          UserEntity,
          JobEntity,
          JobSandboxEntity,
          RepoEntity,
          MessageEntity,
          ThreadEntity,
          StepEntity,
          DecisionRecordEntity,
          StimulusEntity,
        ],
        DB_CONNECTION,
      ),
    ],
    providers: [
      { provide: EnvService, useValue: { get: (k: string) => process.env[k] } },
      { provide: LocalGitService, useValue: new FakeGitService() },
      { provide: SANDBOX_PROVIDER, useValue: new FakeSandboxProvider() },
      SandboxActivityRegistry,
      { provide: TenantCredentialStore, useValue: { presence: async () => ({ hasAnthropic: false, hasGithub: false, engineAuthSet: false }), get: async () => undefined } },
      {
        provide: CredentialResolver,
        useValue: {
          anthropicKey: async () => undefined,
          openaiKey: async () => undefined,
          githubToken: async () => undefined,
          engineAuth: async () => ({ secret: 'test-secret' }),
        },
      },
      { provide: GithubPrService, useValue: { getRepo: async () => null, openPullRequest: async () => ({ url: '', existing: false }), getPullState: async () => 'open' } },
      { provide: DRIVER_REPO, useValue: { resolve: async (): Promise<ResolvedRepo> => { throw new Error('not used'); } } as DriverRepoResolver },
      { provide: WorktreeProvisioner, useValue: { provisionAndAttach: async ({ sandbox }: { sandbox: FeatureSandbox }) => ({ sandbox, hydrationSig: 'sig' }) } },
      { provide: TicketService, useValue: { revertForDeletedThread: async () => {} } },
      { provide: TurnRegistry, useValue: { failRunningForJob: async () => 0 } },
      { provide: SkillUpdaterService, useValue: { reconcileOrgAsync: () => undefined } },
      JobLifecycleService,
      { provide: JOB_TEARDOWN, useExisting: JobLifecycleService },
      OrganizationService,
    ],
  }).compile();

  orgService = mod.get(OrganizationService);
  threadLifecycle = mod.get(JobLifecycleService);
  ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await purge();
  await ds.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'shared@x.com', 'h')`, [SHARED_USER_ID]);
  repoId = await seedOrgWithRepo(ORG_ID, 'delete-org');
  otherRepoId = await seedOrgWithRepo(OTHER_ORG_ID, 'survivor-org');
});

afterEach(async () => {
  await purge().catch(() => undefined);
  await mod?.close();
});

describe('deleteOrg cascade (live Postgres + fakes)', () => {
  it('removes every org-scoped row across all tables, leaving zero orphans', async () => {
    // Two real jobs (each provisions a job_sandboxes row + fake worktree).
    const t1 = await threadLifecycle.createJob({ orgId: ORG_ID, repoId, baseBranch: 'main', displayName: 'A' });
    const t2 = await threadLifecycle.createJob({ orgId: ORG_ID, repoId, baseBranch: 'main', displayName: 'B' });
    await seedThreadChildren(ORG_ID, repoId, t1.jobId);
    await seedThreadChildren(ORG_ID, repoId, t2.jobId);
    await seedOrgDirect(ORG_ID, repoId, 'tok-del', 'evt-del');

    // Sanity: the rows really exist before the delete.
    expect(await countWhere('jobs', 'org_id', ORG_ID)).toBe(2);
    expect(await countWhere('job_sandboxes', 'org_id', ORG_ID)).toBe(2);
    expect(await countWhere('stimuli', 'org_id', ORG_ID)).toBe(3); // 2 thread-tied + 1 parked event

    await orgService.deleteOrg(ORG_ID);

    // Every org-scoped table is empty for this org — no orphans.
    expect(await countWhere('organizations', 'id', ORG_ID)).toBe(0);
    expect(await countWhere('organization_members', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('org_invites', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('org_credentials', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('repos', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('jobs', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('threads', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('steps', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('decision_records', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('stimuli', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('job_sandboxes', 'org_id', ORG_ID)).toBe(0);
    expect(await countWhere('memory', 'org_id', ORG_ID)).toBe(0);
    // messages carry no org_id — assert by the (now-deleted) jobs' ids.
    const msgs = await ds.query(`SELECT COUNT(*)::int AS c FROM messages WHERE job_id = ANY($1)`, [[t1.jobId, t2.jobId]]);
    expect(Number(msgs[0].c)).toBe(0);

    // The shared user row SURVIVES — orgs share users; only the membership join is removed.
    expect(await countWhere('users', 'id', SHARED_USER_ID)).toBe(1);
  });

  it('is scoped to the target org — a sibling org and its data are untouched', async () => {
    const survivor = await threadLifecycle.createJob({ orgId: OTHER_ORG_ID, repoId: otherRepoId, baseBranch: 'main', displayName: 'keep' });
    await seedThreadChildren(OTHER_ORG_ID, otherRepoId, survivor.jobId);
    await seedOrgDirect(OTHER_ORG_ID, otherRepoId, 'tok-keep', 'evt-keep');

    // Delete a DIFFERENT org (which has no rows of its own here).
    await orgService.deleteOrg(ORG_ID);

    // The sibling org is fully intact.
    expect(await countWhere('organizations', 'id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('repos', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('jobs', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('threads', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('steps', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('decision_records', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('stimuli', 'org_id', OTHER_ORG_ID)).toBe(2);
    expect(await countWhere('job_sandboxes', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('org_credentials', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('org_invites', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('organization_members', 'org_id', OTHER_ORG_ID)).toBe(1);
    expect(await countWhere('memory', 'org_id', OTHER_ORG_ID)).toBe(1);
  });
});
