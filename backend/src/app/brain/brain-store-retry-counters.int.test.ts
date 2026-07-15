/**
 * BrainStoreService retry-counter durability — the brain's two redrive lanes
 * (`benign_abort_redrives` / `transient_retry_redrives`) now live on `jobs` columns instead of an
 * in-memory Map, so a restart/crash-loop can't silently re-grant a fresh budget. Proves the CAS claim
 * methods + the lane-scoped clear against real Postgres (mocking the SQL would defeat the point — the
 * whole risk is atomicity).
 *
 * Lightweight harness (mirrors driver-store.int.test.ts's `TypeOrmModule.forRoot` + `forFeature` pattern):
 * NOT the full-AppModule `brain-store.int.test.ts`, which boots far more than these job-scoped counter
 * methods need. `JobTitler` / `JobDependencyService` are stubbed — `claimBenignAbortRedrive`,
 * `claimTransientRetryRedrive`, and `clearBrainRetryCounters` only touch `this.jobs`.
 */

import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, JobEntity } from '../persistence/entities';
import { JobDependencyService } from '../job-deps';
import { JobTitler } from '../titling';
import { BrainStoreService } from './brain-store.service';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
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

describe('BrainStoreService retry-counter durability (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: BrainStoreService;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        BrainStoreService,
        { provide: JobTitler, useValue: {} },
        { provide: JobDependencyService, useValue: { blockersOf: async () => [] } },
      ],
    }).compile();

    store = mod.get(BrainStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Brain Store Retry Org', 'brain-store-retry-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'brain-store-retry-repo', 'Brain Store Retry Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE jobs RESTART IDENTITY CASCADE');
  });

  async function seedBareJob(): Promise<{ jobId: string }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'brain retry counters',
        kind: 'feature',
        status: 'running',
        base_branch: BASE_BRANCH,
      }),
    );
    return { jobId: job.id };
  }

  it('claimBenignAbortRedrive is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.claimBenignAbortRedrive(jobId, 2)).toEqual({ ok: true, used: 1 });
    expect(await store.claimBenignAbortRedrive(jobId, 2)).toEqual({ ok: true, used: 2 });
    // At the cap → refused, budget unchanged.
    expect(await store.claimBenignAbortRedrive(jobId, 2)).toEqual({ ok: false, used: 2 });
  });

  it('claimTransientRetryRedrive is a CAS bounded by the cap (increments up to cap, then refuses)', async () => {
    const { jobId } = await seedBareJob();
    expect(await store.claimTransientRetryRedrive(jobId, 2)).toEqual({ ok: true, used: 1 });
    expect(await store.claimTransientRetryRedrive(jobId, 2)).toEqual({ ok: true, used: 2 });
    // At the cap → refused, budget unchanged.
    expect(await store.claimTransientRetryRedrive(jobId, 2)).toEqual({ ok: false, used: 2 });
  });

  it('claimBenignAbortRedrive and claimTransientRetryRedrive both stamp retry_last_attempt_at', async () => {
    const { jobId } = await seedBareJob();
    const before = Date.now();
    expect(await store.claimBenignAbortRedrive(jobId, 5)).toEqual({ ok: true, used: 1 });
    let row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.retry_last_attempt_at).toBeInstanceOf(Date);
    expect(row!.retry_last_attempt_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    expect(await store.claimTransientRetryRedrive(jobId, 5)).toEqual({ ok: true, used: 1 });
    row = await jobs.findOne({ where: { id: jobId } });
    expect(row?.retry_last_attempt_at).toBeInstanceOf(Date);
    expect(row!.retry_last_attempt_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('two concurrent claimBenignAbortRedrive calls at the cap boundary — exactly one succeeds (row-level CAS)', async () => {
    const { jobId } = await seedBareJob();
    await store.claimBenignAbortRedrive(jobId, 2); // used → 1
    // Two racing claims with cap 2: only one may take the last slot (used 1 → 2).
    const [a, b] = await Promise.all([
      store.claimBenignAbortRedrive(jobId, 2),
      store.claimBenignAbortRedrive(jobId, 2),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect(oks[0]).toEqual({ ok: true, used: 2 });
  });

  it("clearBrainRetryCounters zeroes only the brain lanes — leaves retry_last_attempt_at and the driver's lanes untouched", async () => {
    const { jobId } = await seedBareJob();
    await store.claimBenignAbortRedrive(jobId, 5);
    await store.claimTransientRetryRedrive(jobId, 5);
    // Bump the driver's own lane columns directly (no DriverStoreService in scope here) to prove
    // clearBrainRetryCounters doesn't reach across lanes.
    await jobs.update({ id: jobId }, { auth_retry_attempts: 3, driver_transient_retries: 4 });
    const before = await jobs.findOne({ where: { id: jobId } });
    const stampBefore = before!.retry_last_attempt_at;
    expect(stampBefore).toBeInstanceOf(Date);

    await store.clearBrainRetryCounters(jobId);

    const after = await jobs.findOne({ where: { id: jobId } });
    expect(after?.benign_abort_redrives).toBe(0);
    expect(after?.transient_retry_redrives).toBe(0);
    // Untouched by the brain-lane clear.
    expect(after?.retry_last_attempt_at).toEqual(stampBefore);
    expect(after?.auth_retry_attempts).toBe(3);
    expect(after?.driver_transient_retries).toBe(4);
  });
});
