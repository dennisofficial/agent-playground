/**
 * JobDependencyService + JobUnblockSweep — the "blocked by" edge model and the wake funnel, proven
 * against live Postgres (atlas_test schema; no fakes on the persistence side — the REAL StimulusStoreService
 * records the queued block/unblock seeds). The only stubbed collaborator is BrainGateway — replaced with a
 * capture double so we can assert the funnel ORDER (the JIT unblock note is recorded, with which blocker
 * roster, then the pump is invoked) without booting the brain. Because the wake seam is mocked, the actual
 * coalesced-turn drain is not exercised here — that lives in the live funnel run
 * (web-surface.create-job-depends-on.int.test.ts). (The rendered note text is unit-tested in
 * seed-catalog.spec.ts.)
 *
 * Covers the spec Validation scenarios (02-block-unblock-seeds.md §Validation):
 *  (a) addDependency rejects a cycle and a cross-repo edge;
 *  (b) a born-blocked edge parks the dependent + queues its provenance note + brief (undelivered) and does
 *      NOT wake it; a mid-flight block queues one "blocked" note;
 *  (c) onBlockerResolved('merged') records the unblock note (blocker: merged), flips open, and pumps;
 *  (d) a multi-blocker dependent stays blocked until the LAST blocker resolves;
 *  (e) each non-merge resolution (closed_unmerged / cancelled / deleted) is reported in the blocker roster;
 *  (f) JobUnblockSweep unblocks a job whose blocker row is absent (a dropped-event backstop);
 *  (g) removeDependency manually lifts an edge and reports it as `removed` in the roster.
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { UnblockBlockerInfo } from '@shared/domain';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { JobUnblockSweep } from '../../driver/job-unblock-sweep.service';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { BrainGateway } from '../brain-gateway';
import { JobDependencyService } from '../job-dependency.service';

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

interface UnblockNoteCall {
  jobId: string;
  orgId: string;
  repoId: string;
  blockers: UnblockBlockerInfo[];
}

interface PumpCall {
  jobId: string;
  orgId: string;
  repoId: string;
}

interface SeedRow {
  type: string | null;
  body: string;
  delivered_at: Date | null;
  lane: string | null;
  reply_route: Record<string, unknown> | null;
}

describe('JobDependencyService + JobUnblockSweep (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let service: JobDependencyService;
  let sweep: JobUnblockSweep;
  let jobs: Repository<JobEntity>;
  let repoId: string;
  let otherRepoId: string;
  // The wake seam is mocked, so the coalesced-turn drain is not exercised here (that lives in the live
  // funnel run — web-surface.create-job-depends-on.int.test.ts). This suite proves the FUNNEL ORDER: the
  // JIT unblock note is recorded (captured) before the flip, then the pump is invoked; and that
  // addDependency queues the block/unblock CONTEXT as durable undelivered `main`-lane seed rows.
  let noteCalls: UnblockNoteCall[];
  let pumpCalls: PumpCall[];
  let pauseUnblockNote: Promise<void> | null;
  let signalUnblockNoteEntered: (() => void) | null;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [
        JobDependencyService,
        JobUnblockSweep,
        // The REAL stimulus store (+ its bootstrap) so addDependency records genuine born-blocked /
        // mid-flight seed rows we can assert against.
        StimulusStoreService,
        JobBootstrapService,
        {
          provide: BrainGateway,
          useValue: {
            recordUnblockNote: async (
              jobId: string,
              orgId: string,
              repoId: string,
              input: { blockers: UnblockBlockerInfo[] },
            ) => {
              noteCalls.push({
                jobId,
                orgId,
                repoId,
                blockers: input.blockers,
              });
              signalUnblockNoteEntered?.();
              signalUnblockNoteEntered = null;
              if (pauseUnblockNote) {
                const wait = pauseUnblockNote;
                pauseUnblockNote = null;
                await wait;
              }
            },
            pumpUnblockedJob: async (jobId: string, orgId: string, repoId: string) => {
              pumpCalls.push({ jobId, orgId, repoId });
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
    noteCalls = [];
    pumpCalls = [];
    pauseUnblockNote = null;
    signalUnblockNoteEntered = null;
  });

  /** The durable undelivered `main`-lane seed rows a job carries (born-blocked provenance+brief, or the
   *  mid-flight "blocked" note) — the queue that replaced `jobs.blocked_seed_message`. Oldest-first. */
  async function seedRows(jobId: string): Promise<SeedRow[]> {
    return ds.query(
      `SELECT type, body, delivered_at, lane, reply_route FROM inbound_messages
        WHERE job_id = $1 AND kind = 'chat' ORDER BY created_at ASC`,
      [jobId],
    );
  }

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
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: b.id,
      dependsOnJobId: a.id,
    });
    // a depends on b — would close a cycle (a → b → a).
    await expect(
      service.addDependency({
        orgId: ORG_ID,
        repoId,
        jobId: a.id,
        dependsOnJobId: b.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Self-edge is rejected too.
    await expect(
      service.addDependency({
        orgId: ORG_ID,
        repoId,
        jobId: b.id,
        dependsOnJobId: b.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Cross-repo: a blocker in a different repo is not found in this repo scope.
    const foreign = await makeJob({ repo_id: otherRepoId });
    await expect(
      service.addDependency({
        orgId: ORG_ID,
        repoId,
        jobId: b.id,
        dependsOnJobId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ── (b) born-blocked edge parks the dependent + queues the seed rows, does NOT wake it ─────────
  it('(b) addDependency with a seed parks the dependent and queues the born-blocked seeds without waking it', async () => {
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

    // Two undelivered `main`-lane follow_up_job_seed rows: the provenance note, then the brief.
    const rows = await seedRows(dependent.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.delivered_at === null)).toBe(true);
    expect(rows.every((r) => (r.lane ?? 'main') === 'main')).toBe(true);
    expect(rows.every((r) => r.type === 'follow_up_job_seed')).toBe(true);
    expect(rows[0].reply_route?.bornBlockedSeed).toBe(true); // provenance note carries the dedupe flag
    expect(rows[1].reply_route?.bornBlockedSeed).toBeUndefined(); // the brief is flag-less
    expect(rows[1].body).toBe('build the follow-up'); // the brief verbatim

    expect(noteCalls).toHaveLength(0); // parked, never woken
    expect(pumpCalls).toHaveLength(0);
  });

  it('(b) a re-driven born-blocked edge on an already-blocked job does NOT stack a second set of seeds', async () => {
    const blocker = await makeJob({ status: 'running' });
    const other = await makeJob({ status: 'running' });
    const dependent = await makeJob();

    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'build the follow-up',
    });
    // A second blocker edge on the now-blocked job also carries a seed — must dedupe (one set only).
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: other.id,
      seed: 'build the follow-up',
    });

    expect(await seedRows(dependent.id)).toHaveLength(2);
  });

  it('(b) adding another live blocker to an already born-blocked job does NOT add a mid-flight block note', async () => {
    const blocker = await makeJob({ status: 'running' });
    const other = await makeJob({ status: 'running' });
    const dependent = await makeJob();

    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
      seed: 'build the follow-up',
    });
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: other.id,
    });

    const rows = await seedRows(dependent.id);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.reply_route?.blockNote)).toBe(false);
  });

  it('(b) a mid-flight block (no seed) queues one "blocked" note', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob({ status: 'planning' });

    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });

    const rows = await seedRows(dependent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered_at).toBeNull();
    expect(rows[0].lane ?? 'main').toBe('main');
    expect(rows[0].reply_route?.blockNote).toBe(true);
    expect(noteCalls).toHaveLength(0);
  });

  it('rejects blocking a job while its brain turn is active', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob({ activity: 'turn' });

    await expect(
      service.addDependency({
        orgId: ORG_ID,
        repoId,
        jobId: dependent.id,
        dependsOnJobId: blocker.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── (c) merge → record unblock note (while blocked) + flip open + pump (blocker roster: merged) ─
  it('(c) onBlockerResolved(merged) records the unblock note, flips open, and pumps — note reports merged', async () => {
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
    // The JIT unblock note was recorded with the resolved blocker roster, and the pump was invoked.
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].jobId).toBe(dependent.id);
    expect(noteCalls[0].blockers).toEqual([{ jobId: blocker.id, title: 'A job', how: 'merged' }]);
    expect(pumpCalls.map((p) => p.jobId)).toEqual([dependent.id]);
    // The born-blocked brief still sits in the queue (the pump is mocked here, so nothing drained it).
    const rows = await seedRows(dependent.id);
    expect(rows.map((r) => r.body)).toContain('build the follow-up');
  });

  // ── (d) multi-blocker: stays blocked until the LAST blocker resolves ───────────────────────────
  it('(d) a multi-blocker dependent stays blocked until every blocker is terminal', async () => {
    const a = await makeJob({ status: 'running' });
    const c = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: a.id,
    });
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: c.id,
    });

    // First blocker merges — dependent still blocked on c.
    await jobs.update({ id: a.id }, { pr_state: 'merged', status: 'done' });
    await service.onBlockerResolved(a.id, 'merged');
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');
    expect(noteCalls).toHaveLength(0);

    // Last blocker merges — now it unblocks.
    await jobs.update({ id: c.id }, { pr_state: 'merged', status: 'done' });
    await service.onBlockerResolved(c.id, 'merged');
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].blockers.map((b) => b.how)).toEqual(['merged', 'merged']); // both merged cleanly
  });

  it('serializes concurrent unblock attempts so only the winner records and pumps', async () => {
    const a = await makeJob({ status: 'running', title: 'blocker A' });
    const b = await makeJob({ status: 'running', title: 'blocker B' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: a.id,
    });
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: b.id,
    });
    await jobs.update({ id: a.id }, { pr_state: 'merged', status: 'done' });
    await jobs.update({ id: b.id }, { pr_state: 'merged', status: 'done' });

    let releaseFirstNote!: () => void;
    const firstNoteEntered = new Promise<void>((resolve) => {
      signalUnblockNoteEntered = resolve;
    });
    pauseUnblockNote = new Promise<void>((resolve) => {
      releaseFirstNote = resolve;
    });

    const first = service.onBlockerResolved(a.id, 'merged');
    await firstNoteEntered;
    const second = service.onBlockerResolved(b.id, 'merged');

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(noteCalls).toHaveLength(1);
    expect(pumpCalls).toHaveLength(0);

    releaseFirstNote();
    await Promise.all([first, second]);

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    expect(pumpCalls.map((p) => p.jobId)).toEqual([dependent.id]);
  });

  // ── (e) non-merge resolutions are reported in the blocker roster ───────────────────────────────
  it('(e) closed-unmerged is reported with how="closed_unmerged"', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob({ title: 'downstream' });
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });

    await jobs.update({ id: blocker.id }, { pr_state: 'closed', status: 'done' });
    await service.onBlockerResolved(blocker.id, 'closed_unmerged');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].blockers).toEqual([
      { jobId: blocker.id, title: 'A job', how: 'closed_unmerged' },
    ]);
  });

  it('(e) a cancelled blocker is reported with how="cancelled"', async () => {
    const blocker = await makeJob({ status: 'running', title: 'the blocker' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });

    await jobs.update({ id: blocker.id }, { status: 'cancelled' });
    await service.onBlockerResolved(blocker.id, 'cancelled');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls[0].blockers).toEqual([
      { jobId: blocker.id, title: 'the blocker', how: 'cancelled' },
    ]);
  });

  it('(e) a deleted blocker (row still present at call time) is reported with how="deleted"', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });

    // deleteJobDeep calls onBlockerResolved BEFORE the row delete — the blocker still looks non-terminal
    // from state, so the funnel must treat the resolving blocker as terminal unconditionally.
    await service.onBlockerResolved(blocker.id, 'deleted');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls[0].blockers).toEqual([{ jobId: blocker.id, title: 'A job', how: 'deleted' }]);
  });

  it('reports an already-deleting sibling blocker as deleted alongside the resolving one', async () => {
    const deleting = await makeJob({
      status: 'running',
      title: 'teardown blocker',
    });
    const closing = await makeJob({
      status: 'running',
      title: 'closing blocker',
    });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: deleting.id,
    });
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: closing.id,
    });

    await jobs.update({ id: deleting.id }, { status: 'deleting' });
    await jobs.update({ id: closing.id }, { pr_state: 'closed', status: 'done' });
    await service.onBlockerResolved(closing.id, 'closed_unmerged');

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    const hows = noteCalls[0].blockers.map((b) => b.how);
    expect(hows).toContain('deleted');
    expect(hows).toContain('closed_unmerged');
    expect(hows).not.toContain('cancelled');
  });

  // ── (f) JobUnblockSweep unblocks a job whose blocker row is absent ─────────────────────────────
  it('(f) the sweep unblocks a blocked job whose blocker edge has vanished', async () => {
    const blocker = await makeJob({ status: 'running' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');

    // A dropped wake event: the blocker vanishes (hard delete cascades its job_dependencies edge) but
    // the dependent is still parked. The sweep must reconcile it.
    await jobs.delete({ id: blocker.id });

    const unblocked = await sweep.tick();
    expect(unblocked).toBe(1);
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].blockers).toEqual([]); // the blocker row vanished, so there is nothing to name
  });

  // ── (g) removeDependency manually lifts an edge, reported as `removed` ─────────────────────────
  it('(g) removeDependency wakes the dependent and reports the lifted edge as "removed"', async () => {
    const blocker = await makeJob({ status: 'running', title: 'the blocker' });
    const dependent = await makeJob();
    await service.addDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });
    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('blocked');

    await service.removeDependency({
      orgId: ORG_ID,
      repoId,
      jobId: dependent.id,
      dependsOnJobId: blocker.id,
    });

    expect((await jobs.findOneByOrFail({ id: dependent.id })).status).toBe('open');
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].blockers).toEqual([
      { jobId: blocker.id, title: 'the blocker', how: 'removed' },
    ]);
  });

  // ── listJobs — repo-scoped discovery + the terminal-blocker default filter ─────────────────────
  describe('listJobs', () => {
    const idsOf = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

    it('is repo-scoped: never returns a job from another repo', async () => {
      const here = await makeJob({ status: 'running', title: 'here' });
      const foreign = await makeJob({
        repo_id: otherRepoId,
        status: 'running',
        title: 'foreign',
      });

      const rows = await service.listJobs({ orgId: ORG_ID, repoId });
      expect(idsOf(rows).has(here.id)).toBe(true);
      expect(idsOf(rows).has(foreign.id)).toBe(false);
    });

    it('DEFAULT filter mirrors the terminal-blocker rule (NULL-safe)', async () => {
      const doneOpenPr = await makeJob({
        status: 'done',
        pr_state: 'open',
        title: 'done-open-pr',
      });
      const amending = await makeJob({ status: 'amending', title: 'amending' });
      const noPr = await makeJob({
        status: 'planning',
        pr_state: null,
        title: 'no-pr-yet',
      });
      const doneMerged = await makeJob({
        status: 'done',
        pr_state: 'merged',
        title: 'done-merged',
      });
      const closed = await makeJob({
        status: 'done',
        pr_state: 'closed',
        title: 'closed',
      });
      const cancelled = await makeJob({
        status: 'cancelled',
        title: 'cancelled',
      });
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
      const doneOpen = await makeJob({
        status: 'done',
        pr_state: 'open',
        title: 'done-open',
      });
      const doneMerged = await makeJob({
        status: 'done',
        pr_state: 'merged',
        title: 'done-merged',
      });
      const cancelled = await makeJob({
        status: 'cancelled',
        title: 'cancelled',
      });

      const done = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        status: 'done',
      });
      expect(idsOf(done)).toEqual(new Set([doneOpen.id, doneMerged.id])); // incl. the merged one

      const all = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        status: 'all',
      });
      const allIds = idsOf(all);
      expect(allIds.has(cancelled.id)).toBe(true);
      expect(allIds.has(doneMerged.id)).toBe(true);
    });

    it('query filters by case-insensitive title substring', async () => {
      const auth = await makeJob({ status: 'running', title: 'Fix AUTH flow' });
      await makeJob({ status: 'running', title: 'Refactor billing' });

      const rows = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        query: 'auth',
      });
      expect(idsOf(rows)).toEqual(new Set([auth.id]));
    });

    it('caps the result and returns newest-first', async () => {
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const j = await makeJob({ status: 'running', title: `job ${i}` });
        created.push(j.id);
      }
      const limited = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        limit: 2,
      });
      expect(limited).toHaveLength(2);
      // newest-first: the last two created, most-recent first.
      expect(limited.map((r) => r.id)).toEqual([created[4], created[3]]);

      // hard cap: an over-limit request is clamped to 100 (well above our 5 rows, so all 5 return).
      const capped = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        limit: 9999,
      });
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
      const [row] = await service.listJobs({
        orgId: ORG_ID,
        repoId,
        query: 'projection',
      });
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
