import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '@shared/engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import {
  BrainTurnAlreadyRunningError,
  TurnRegistry,
} from './turn-registry.service';

/**
 * Int test for the `ux_active_turns_one_running_brain_per_job` partial unique index (the hard cross-process
 * backstop against two brain turns resuming one engine session — the "parallel co-author" bug). Proves at
 * the REAL DB that a second `running` brain turn for a job is rejected as `BrainTurnAlreadyRunningError`,
 * while a non-brain turn, a different job, and a re-register after the first finalized are all allowed.
 *
 * Boots the REAL AppModule against live Postgres, mocking only external boundaries (none are exercised).
 */
const TEAM_ID = '44444444-4444-4444-8444-444444444444'; // sentinel org uuid

describe('single running brain turn per job (live Postgres partial unique index)', () => {
  let app: NestExpressApplication;
  let registry: TurnRegistry;
  let dataSource: DataSource;
  let jobA = '';
  let jobB = '';

  const prevSurface = process.env.SURFACE;

  const reg = (turnId: string, jobId: string, kind: 'brain' | 'step') => ({
    turnId,
    jobId,
    orgId: TEAM_ID,
    channel: 'repo-guard',
    lane: 'main',
    kind,
    containerId: 'c1',
    ctx: { orgId: TEAM_ID, jobId },
  });

  beforeAll(async () => {
    process.env.SURFACE = 'agent';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .overrideProvider(JobTitler)
      .useValue(new FakeThreadTitler())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    app.enableShutdownHooks();
    await app.init();

    registry = app.get(TurnRegistry);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    // Seed the FK chain: org → repo → two jobs (active_turns.job_id → jobs.id).
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID, 'guard-org', 'guard-org'],
    );
    const [repo] = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        TEAM_ID,
        `guard-repo-${randomUUID().slice(0, 8)}`,
        'guard-repo',
        'https://example.invalid/r.git',
      ],
    );
    const mkJob = async () => {
      const [job] = await dataSource.query(
        `INSERT INTO jobs (org_id, repo_id, origin) VALUES ($1,$2,$3) RETURNING id`,
        [TEAM_ID, repo.id, 'chat'],
      );
      return job.id as string;
    };
    jobA = await mkJob();
    jobB = await mkJob();
  }, 60_000);

  afterAll(async () => {
    if (dataSource) {
      await dataSource.query(`DELETE FROM active_turns WHERE org_id = $1`, [
        TEAM_ID,
      ]);
      await dataSource.query(`DELETE FROM jobs WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM repos WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [
        TEAM_ID,
      ]);
    }
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  // `turn_id` is a uuid column, so every turn needs a real uuid; `brain1` is finalized in the last test.
  const brain1 = randomUUID();

  it('rejects a SECOND running brain turn for the same job (BrainTurnAlreadyRunningError)', async () => {
    await registry.register(reg(brain1, jobA, 'brain'));
    await expect(
      registry.register(reg(randomUUID(), jobA, 'brain')),
    ).rejects.toBeInstanceOf(BrainTurnAlreadyRunningError);
  });

  it('ALLOWS a non-brain (step) turn alongside the running brain turn on the same job', async () => {
    // brain1 from the previous test is still running for jobA.
    await expect(
      registry.register(reg(randomUUID(), jobA, 'step')),
    ).resolves.toBeUndefined();
  });

  it('ALLOWS a brain turn on a DIFFERENT job', async () => {
    await expect(
      registry.register(reg(randomUUID(), jobB, 'brain')),
    ).resolves.toBeUndefined();
  });

  it('ALLOWS a fresh brain turn once the prior one is finalized', async () => {
    await registry.finalize(brain1, 'done');
    await expect(
      registry.register(reg(randomUUID(), jobA, 'brain')),
    ).resolves.toBeUndefined();
  });
});
