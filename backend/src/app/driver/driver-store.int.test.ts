/**
 * DriverStoreService.getPipelineState — the web `/pipeline` read model.
 *
 * Proves (against live Postgres) that the payload the operator console renders the navigator from now
 * carries the track's STEPS (the execute folder's leaves) + the track `hasPlan` flag, and the
 * thread's PR + branch on the job — the fields the thread-sidebar handoff added. Additive over the old
 * shape (id/ordinal/brief/status), so the brain's `get_pipeline_state` passthrough is unaffected.
 *
 * Integration: real Postgres (atlas_test schema), no fakes (the method only touches repositories).
 * Seeds an org/repo/thread + tracks + steps directly, then asserts the mapped read model.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, StepEntity, TrackEntity, JobEntity } from '../persistence/entities';
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
  let threads: Repository<JobEntity>;
  let tracks: Repository<TrackEntity>;
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
    threads = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    tracks = mod.get(getRepositoryToken(TrackEntity, DB_CONNECTION));
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
    await ds.query('TRUNCATE steps, tracks, threads RESTART IDENTITY CASCADE');
  });

  it('returns steps + hasPlan per track and the PR + branch on the job', async () => {
    const thread = await threads.save(
      threads.create({
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
    const track = await tracks.save(
      tracks.create({
        thread_id: thread.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — wire the webhook handler',
        plan: 'detailed plan prose', // → hasPlan: true
        status: 'executing',
      }),
    );
    await steps.save([
      steps.create({
        track_id: track.id,
        thread_id: thread.id,
        org_id: ORG_ID,
        ordinal: 10,
        title: 'replay',
        brief: 'build replay',
        stage: 'build',
        status: 'building',
      }),
      steps.create({
        track_id: track.id,
        thread_id: thread.id,
        org_id: ORG_ID,
        ordinal: 20,
        title: 'sync',
        brief: 'build sync',
        stage: 'build',
        status: 'pending',
      }),
    ]);

    const state = (await store.getPipelineState(thread.id, ORG_ID)) as {
      status: string;
      prUrl: string | null;
      prNumber: number | null;
      featureBranch: string | null;
      baseBranch: string | null;
      tracks: Array<{
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

    expect(state.tracks).toHaveLength(1);
    const [sec] = state.tracks;
    expect(sec.hasPlan).toBe(true);
    // The review-agent run list is exposed per track (fixed set today; navigator renders it dynamically).
    // An un-reviewed track (empty `review_agents`) falls back to the default lens set at `pending`.
    expect(sec.reviewAgents.map((a) => a.id)).toEqual(['best_practices', 'correctness', 'consistency']);
    expect(sec.reviewAgents.every((a) => a.status === 'pending')).toBe(true);
    expect(sec.steps.map((p) => p.title)).toEqual(['replay', 'sync']); // ordinal-sorted
    expect(sec.steps[0].status).toBe('building');
    expect(sec.steps[1].status).toBe('pending');
  });

  it('seeds, transitions, and finalizes per-agent review status (surfaced by getPipelineState)', async () => {
    const thread = await threads.save(
      threads.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'review status',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    const track = await tracks.save(
      tracks.create({
        thread_id: thread.id,
        org_id: ORG_ID,
        ordinal: 10,
        brief: 'Backend — review status',
        status: 'auto_fixing',
      }),
    );

    // Seed at pending → run + pass one lens (with a finding count) → finalize the rest.
    await store.seedReviewAgents(track.id, [
      { id: 'best_practices', label: 'BP', status: 'pending' },
      { id: 'correctness', label: 'C', status: 'pending' },
      { id: 'consistency', label: 'Cs', status: 'pending' },
    ]);
    await store.setReviewAgentStatus(track.id, 'best_practices', 'running');
    await store.setReviewAgentStatus(track.id, 'best_practices', 'passed', 2);
    // correctness ran (in lensesRun) but never reached terminal → passed; consistency didn't run → skipped.
    await store.finalizeReviewAgents(track.id, ['best_practices', 'correctness']);

    const state = (await store.getPipelineState(thread.id, ORG_ID)) as {
      tracks: Array<{ reviewAgents: Array<{ id: string; status: string; findings?: number }> }>;
    };
    const byId = new Map(state.tracks[0].reviewAgents.map((a) => [a.id, a]));
    expect(byId.get('best_practices')).toMatchObject({ status: 'passed', findings: 2 });
    expect(byId.get('correctness')?.status).toBe('passed');
    expect(byId.get('consistency')?.status).toBe('skipped');
  });

  it('still reports `no_job` for a thread that has not entered the build lifecycle', async () => {
    const thread = await threads.save(
      threads.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'just chatting',
        status: 'open',
        base_branch: BASE_BRANCH,
      }),
    );
    expect(await store.getPipelineState(thread.id, ORG_ID)).toEqual({ status: 'no_job' });
  });
});
