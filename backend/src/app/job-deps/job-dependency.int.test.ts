/**
 * JobDependencyService + JobUnblockSweep — the "blocked by" edge model and the wake funnel, proven
 * against live Postgres (atlas_test schema; no fakes on the persistence side). The only stubbed
 * collaborator is BrainGateway — replaced with a capture double so we can assert exactly which jobs are
 * woken, with which replayed seed and which "didn't land" note, without booting the brain.
 *
 * Covers the spec Validation scenarios (02-backend-dependencies-wake.md §Validation, a–f):
 *  (a) addDependency rejects a cycle and a cross-repo edge;
 *  (b) a born-blocked edge parks the dependent with its seed and does NOT wake it;
 *  (c) onBlockerResolved('merged') unblocks, clears the seed, and dispatches a wake (no note);
 *  (d) a multi-blocker dependent stays blocked until the LAST blocker resolves;
 *  (e) each non-merge resolution (closed_unmerged / cancelled / deleted) unblocks WITH a "didn't land" note;
 *  (f) JobUnblockSweep unblocks a job whose blocker row is absent (a dropped-event backstop).
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { BrainGateway } from '../brain-gateway';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, JobEntity } from '../persistence/entities';
import { JobUnblockSweep } from '../driver/job-unblock-sweep.service';
import { JobDependencyService } from './job-dependency.service';

const ORG_ID = '2c111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';

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

interface WakeCall {
  jobId: string;
  orgId: string;
  repoId: string;
  seed: string | null;
  note: string | null;
}

describe('JobDependencyService + JobUnblockSweep (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let service: JobDependencyService;
  let sweep: JobUnblockSweep;
  let jobs: Repository<JobEntity>;
  let repoId: string;
  let otherRepoId: string;
  let wakes: WakeCall[];

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        JobDependencyService,
        JobUnblockSweep,
        {
          provide: BrainGateway,
          useValue: {
            wakeUnblockedJob: async (
              jobId: string,
              orgId: string,
              repoId: string,
              input: { seed: string | null; note: string | null },
            ) => {
              wakes.push({ jobId, orgId, repoId, seed: input.seed, note: input.note });
            },
          },
        },
      ],
    }).compile();

    service = mod.get(JobDependencyService);
    sweep = mod.get(JobUnblockSweep);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Job Dep Org', 'job-dep-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'job-dep-repo', 'Job Dep Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
    const otherRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'job-dep-repo-2', 'Job Dep Repo 2', 'https://github.com/x/z.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    otherRepoId = otherRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE job_dependencies, jobs RESTART IDENTITY CASCADE');
    wakes = [];
  });

  async function makeJob(overrides: Partial<JobEntity> = {}): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'A job',
        kind: 'feature',
        status: 'open',
        base_branch: BASE_BRANCH,
        ...overrides,
      }),
    );
  }

  // ── (a) cycle + cross-repo rejection ──────────────────────────────────────────────────────────
  it('(a) rejects a dependency cycle and a cross-repo edge', async () => {
    const a = await makeJob({ status: 'running' }); // a live (non-terminal) blocker
    const b = await makeJob();

    // b depends on a — fine.
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: b.id, dependsOnJobId: a.id });
    // a depends on b — would close a cycle (a → b → a).
    await expect(
      service.addDependency({ orgId: ORG_ID, repoId, jobId: a.id, dependsOnJobId: b.id }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Self-edge is rejected too.
    await expect(
      service.addDependency({ orgId: ORG_ID, repoId, jobId: b.id, dependsOnJobId: b.id }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Cross-repo: a blocker in a different repo is not found in this repo scope.
    const foreign = await makeJob({ repo_id: otherRepoId });
    await expect(
      service.addDependency({ orgId: ORG_ID, repoId, jobId: b.id, dependsOnJobId: foreign.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── (b) born-blocked edge parks the dependent with a seed, does NOT wake it ────────────────────
  it('(b) addDependency with a seed parks the dependent and stores the seed without waking it', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();

    const res = await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'build the follow-up',
    });

    expect(res.blocked).toBe(true);
    const reloaded = await jobs.findOneByOrFail({ id: dependent.id });
    expect(reloaded.status).toBe('blocked');
    expect(reloaded.blocked_seed_message).toBe('build the follow-up');
    expect(wakes).toHaveLength(0); // parked, never started
  });

  it('rejects blocking a job while its brain turn is active', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob({ activity: 'turn' });

    await expect(
      service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: blocker.id }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── (c) merge → unblock + clear seed + wake (no note) ─────────────────────────────────────────
  it('(c) onBlockerResolved(merged) unblocks, clears the seed, and wakes with no "didn\'t land" note', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'build the follow-up',
    });

    // The blocker's PR merges.
    await jobs.update({ id: blocker.id }, { pr_state: 'merged', status: 'done' });
    await service.onBlockerResolved(blocker.id, 'merged');

    const reloaded = await jobs.findOneByOrFail({ id: dependent.id });
    expect(reloaded.status).toBe('open');
    expect(reloaded.blocked_seed_message).toBeNull();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ jobId: dependent.id, seed: 'build the follow-up', note: null });
  });

  // ── (d) multi-blocker: stays blocked until the LAST blocker resolves ───────────────────────────
  it('(d) a multi-blocker dependent stays blocked until every blocker is terminal', async () => {
    const a = await makeJob({ status: 'running' });
    const c = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: a.id });
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: c.id });

    // First blocker merges — dependent still blocked on c.
    await jobs.update({ id: a.id }, { pr_state: 'merged', status: 'done' });
    await service.onBlockerResolved(a.id, 'merged');
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');
    expect(wakes).toHaveLength(0);

    // Last blocker merges — now it unblocks.
    await jobs.update({ id: c.id }, { pr_state: 'merged', status: 'done' });
    await service.onBlockerResolved(c.id, 'merged');
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].note).toBeNull(); // both merged cleanly
  });

  // ── (e) non-merge resolutions unblock WITH a "didn't land" note ────────────────────────────────
  it('(e) closed-unmerged unblocks with a "PR closed without merging" note', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob({ title: 'downstream' });
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: blocker.id });

    await jobs.update({ id: blocker.id }, { pr_state: 'closed', status: 'done' });
    await service.onBlockerResolved(blocker.id, 'closed_unmerged');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].note).toContain('did NOT merge');
    expect(wakes[0].note).toContain('PR closed without merging');
  });

  it('(e) a cancelled blocker unblocks with a "job cancelled" note', async () => {
    const blocker = await makeJob({ status: 'running', title: 'the blocker' });
    const dependent = await makeJob();
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: blocker.id });

    await jobs.update({ id: blocker.id }, { status: 'cancelled' });
    await service.onBlockerResolved(blocker.id, 'cancelled');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(wakes[0].note).toContain('job cancelled');
  });

  it('(e) a deleted blocker (row still present at call time) unblocks with a "job deleted" note', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: blocker.id });

    // deleteJobDeep calls onBlockerResolved BEFORE the row delete — the blocker still looks non-terminal
    // from state, so the funnel must treat the resolving blocker as terminal unconditionally.
    await service.onBlockerResolved(blocker.id, 'deleted');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(wakes[0].note).toContain('job deleted');
  });

  // ── (f) JobUnblockSweep unblocks a job whose blocker row is absent ─────────────────────────────
  it('(f) the sweep unblocks a blocked job whose blocker edge has vanished', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({ orgId: ORG_ID, repoId, jobId: dependent.id, dependsOnJobId: blocker.id });
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');

    // A dropped wake event: the blocker vanishes (hard delete cascades its job_dependencies edge) but
    // the dependent is still parked. The sweep must reconcile it.
    await jobs.delete({ id: blocker.id });

    const unblocked = await sweep.tick();
    expect(unblocked).toBe(1);
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(wakes).toHaveLength(1);
    expect(wakes[0].note).toBeNull(); // the sweep is a backstop; the event path composes any note
  });

  // ── listJobs — repo-scoped discovery + the terminal-blocker default filter ─────────────────────
  describe('listJobs', () => {
    const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

    it('is repo-scoped: never returns a job from another repo', async () => {
      const here = await makeJob({ status: 'running', title: 'here' });
      const foreign = await makeJob({ repo_id: otherRepoId, status: 'running', title: 'foreign' });

      const rows = await service.listJobs({ orgId: ORG_ID, repoId });
      expect(idsOf(rows).has(here.id)).toBe(true);
      expect(idsOf(rows).has(foreign.id)).toBe(false);
    });

    it('DEFAULT filter mirrors the terminal-blocker rule (NULL-safe)', async () => {
      const doneOpenPr = await makeJob({ status: 'done', pr_state: 'open', title: 'done-open-pr' });
      const amending = await makeJob({ status: 'amending', title: 'amending' });
      const noPr = await makeJob({ status: 'planning', pr_state: null, title: 'no-pr-yet' });
      const doneMerged = await makeJob({ status: 'done', pr_state: 'merged', title: 'done-merged' });
      const closed = await makeJob({ status: 'done', pr_state: 'closed', title: 'closed' });
      const cancelled = await makeJob({ status: 'cancelled', title: 'cancelled' });
      const deleting = await makeJob({ status: 'deleting', title: 'deleting' });

      const rows = await service.listJobs({ orgId: ORG_ID, repoId });
      const ids = idsOf(rows);
      // Live blockers are INCLUDED (done-with-open-PR, amending, and a job with no PR yet).
      expect(ids.has(doneOpenPr.id)).toBe(true);
      expect(ids.has(amending.id)).toBe(true);
      expect(ids.has(noPr.id)).toBe(true);
      // Dead-as-a-blocker jobs are EXCLUDED.
      expect(ids.has(doneMerged.id)).toBe(false);
      expect(ids.has(closed.id)).toBe(false);
      expect(ids.has(cancelled.id)).toBe(false);
      expect(ids.has(deleting.id)).toBe(false);
    });

    it('an exact status filter bypasses the terminal exclusion; "all" returns everything', async () => {
      const doneOpen = await makeJob({ status: 'done', pr_state: 'open', title: 'done-open' });
      const doneMerged = await makeJob({ status: 'done', pr_state: 'merged', title: 'done-merged' });
      const cancelled = await makeJob({ status: 'cancelled', title: 'cancelled' });

      const done = await service.listJobs({ orgId: ORG_ID, repoId, status: 'done' });
      expect(idsOf(done)).toEqual(new Set([doneOpen.id, doneMerged.id])); // incl. the merged one

      const all = await service.listJobs({ orgId: ORG_ID, repoId, status: 'all' });
      const allIds = idsOf(all);
      expect(allIds.has(cancelled.id)).toBe(true);
      expect(allIds.has(doneMerged.id)).toBe(true);
    });

    it('query filters by case-insensitive title substring', async () => {
      const auth = await makeJob({ status: 'running', title: 'Fix AUTH flow' });
      await makeJob({ status: 'running', title: 'Refactor billing' });

      const rows = await service.listJobs({ orgId: ORG_ID, repoId, query: 'auth' });
      expect(idsOf(rows)).toEqual(new Set([auth.id]));
    });

    it('caps the result and returns newest-first', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const j = await makeJob({ status: 'running', title: `job ${i}` });
        created.push(j.id);
      }
      const limited = await service.listJobs({ orgId: ORG_ID, repoId, limit: 2 });
      expect(limited).toHaveLength(2);
      // newest-first: the last two created, most-recent first.
      expect(limited.map((r) => r.id)).toEqual([created[4], created[3]]);

      // hard cap: an over-limit request is clamped to 100 (well above our 5 rows, so all 5 return).
      const capped = await service.listJobs({ orgId: ORG_ID, repoId, limit: 9999 });
      expect(capped.length).toBe(5);
    });

    it('returns the documented projection fields', async () => {
      const job = await makeJob({
        status: 'done',
        pr_state: 'open',
        pr_number: 42,
        build_path: 'plan',
        title: 'projection',
      });
      const [row] = await service.listJobs({ orgId: ORG_ID, repoId, query: 'projection' });
      expect(row).toMatchObject({
        id: job.id,
        title: 'projection',
        status: 'done',
        prState: 'open',
        kind: 'feature',
        buildPath: 'plan',
        prNumber: 42,
      });
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(typeof row.activity).toBe('string');
    });
  });
});
