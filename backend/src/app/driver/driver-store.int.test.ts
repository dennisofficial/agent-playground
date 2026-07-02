/**
 * DriverStoreService.getPipelineState — the web `/pipeline` read model.
 *
 * Proves (against live Postgres) that the payload the operator console renders the navigator from now
 * carries the thread's STEPS (the execute folder's leaves) + the thread `hasPlan` flag, and the
 * thread's PR + branch on the job — the fields the thread-sidebar handoff added. Additive over the old
 * shape (id/ordinal/brief/status), so the brain's `get_pipeline_state` passthrough is unaffected.
 *
 * Integration: real Postgres (atlas_test schema), no fakes (the method only touches repositories).
 * Seeds an org/repo/thread + threads + steps directly, then asserts the mapped read model.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, StepEntity, ThreadEntity, JobEntity } from '../persistence/entities';
import { DriverStoreService } from './driver-store.service';

const ORG_ID = '21111111-1111-4111-8111-111111111111';
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

describe('DriverStoreService.getPipelineState (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: DriverStoreService;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  let steps: Repository<StepEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [DriverStoreService],
    }).compile();

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    steps = mod.get(getRepositoryToken(StepEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Driver Store Org', 'driver-store-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'driver-store-repo', 'Driver Store Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE steps, threads, jobs RESTART IDENTITY CASCADE');
  });

  it('returns steps + hasPlan per thread and the PR + branch on the job', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Stripe webhooks',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
        feature_branch: 'atlas/feature-stripe',
        pr_url: 'https://github.com/x/y/pull/43',
        pr_number: 43,
      }),
    );
    const thread = await threads.save(
      threads.create({
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — wire the webhook handler',
        plan: 'detailed plan prose', // → hasPlan: true
        status: 'executing',
      }),
    );
    await steps.save([
      steps.create({
        thread_id: thread.id,
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        title: 'replay',
        brief: 'build replay',
        stage: 'build',
        status: 'building',
      }),
      steps.create({
        thread_id: thread.id,
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 20,
        title: 'sync',
        brief: 'build sync',
        stage: 'build',
        status: 'pending',
      }),
    ]);

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      status: string;
      prUrl: string | null;
      prNumber: number | null;
      featureBranch: string | null;
      baseBranch: string | null;
      threads: Array<{
        id: string;
        hasPlan: boolean;
        status: string;
        reviewAgents: Array<{ id: string; label: string; status: string; findings?: number }>;
        steps: Array<{ ordinal: number; title: string | null; stage: string; status: string }>;
      }>;
    };

    expect(state.status).toBe('running');
    expect(state.prUrl).toBe('https://github.com/x/y/pull/43');
    expect(state.prNumber).toBe(43);
    expect(state.featureBranch).toBe('atlas/feature-stripe');
    expect(state.baseBranch).toBe(BASE_BRANCH);

    expect(state.threads).toHaveLength(1);
    const [sec] = state.threads;
    expect(sec.hasPlan).toBe(true);
    // The review-agent run list is exposed per thread (fixed set today; navigator renders it dynamically).
    // An un-reviewed thread (empty `review_agents`) falls back to the default lens set at `pending`.
    expect(sec.reviewAgents.map((a) => a.id)).toEqual(['best_practices', 'correctness', 'consistency']);
    expect(sec.reviewAgents.every((a) => a.status === 'pending')).toBe(true);
    expect(sec.steps.map((p) => p.title)).toEqual(['replay', 'sync']); // ordinal-sorted
    expect(sec.steps[0].status).toBe('building');
    expect(sec.steps[1].status).toBe('pending');
  });

  it('seeds, transitions, and finalizes per-agent review status (surfaced by getPipelineState)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'review status',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const thread = await threads.save(
      threads.create({
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — review status',
        status: 'auto_fixing',
      }),
    );

    // Seed at pending → run + pass one lens (with a finding count) → finalize the rest.
    await store.seedReviewAgents(thread.id, [
      { id: 'best_practices', label: 'BP', status: 'pending' },
      { id: 'correctness', label: 'C', status: 'pending' },
      { id: 'consistency', label: 'Cs', status: 'pending' },
    ]);
    await store.setReviewAgentStatus(thread.id, 'best_practices', 'running');
    await store.setReviewAgentStatus(thread.id, 'best_practices', 'passed', 2);
    // correctness ran (in lensesRun) but never reached terminal → passed; consistency didn't run → skipped.
    await store.finalizeReviewAgents(thread.id, ['best_practices', 'correctness']);

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      threads: Array<{ reviewAgents: Array<{ id: string; status: string; findings?: number }> }>;
    };
    const byId = new Map(state.threads[0].reviewAgents.map((a) => [a.id, a]));
    expect(byId.get('best_practices')).toMatchObject({ status: 'passed', findings: 2 });
    expect(byId.get('correctness')?.status).toBe('passed');
    expect(byId.get('consistency')?.status).toBe('skipped');
  });

  it('surfaces the LLM-authored task list + PR Review status, with NO fallback default (unlike review agents)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'task list',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const thread = await threads.save(
      threads.create({
        job_id: job.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — task list',
        status: 'executing',
      }),
    );

    // An un-touched thread/job: `tasks` is `[]` (no computed fallback — unlike reviewAgents, there's no
    // fixed/expected set for pure LLM output).
    const empty = (await store.getPipelineState(job.id, ORG_ID)) as {
      tasks: unknown[];
      prReviewStatus: string | null;
      threads: Array<{ tasks: unknown[] }>;
    };
    expect(empty.tasks).toEqual([]);
    expect(empty.prReviewStatus).toBeNull();
    expect(empty.threads[0].tasks).toEqual([]);

    // Simulate what the harness's fold does — a direct read-modify-write of the jsonb column — for both
    // the thread's own task list and the job-level PR Review one.
    await threads.update(
      { id: thread.id },
      { tasks: [{ id: 't1', subject: 'Write the migration', status: 'in_progress' }] },
    );
    await store.startPrReview(job.id);
    await store.setPrReviewStatus(job.id, 'running');
    await jobs.update({ id: job.id }, { tasks: [{ id: 't1', subject: 'Master code review', status: 'completed' }] });

    const state = (await store.getPipelineState(job.id, ORG_ID)) as {
      tasks: Array<{ id: string; subject: string; status: string }>;
      prReviewStatus: string | null;
      threads: Array<{ tasks: Array<{ id: string; subject: string; status: string }> }>;
    };
    expect(state.threads[0].tasks).toEqual([
      { id: 't1', subject: 'Write the migration', status: 'in_progress' },
    ]);
    expect(state.tasks).toEqual([{ id: 't1', subject: 'Master code review', status: 'completed' }]);
    expect(state.prReviewStatus).toBe('running');
  });

  it('still reports `no_job` for a thread that has not entered the build lifecycle', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'just chatting',
        status: 'open',
        base_branch: BASE_BRANCH,
      }),
    );
    // `no_job` still carries the brain's own task list — the navigator's Main row shows it pre-plan.
    expect(await store.getPipelineState(job.id, ORG_ID)).toEqual({ status: 'no_job', mainTasks: [] });
  });
});
