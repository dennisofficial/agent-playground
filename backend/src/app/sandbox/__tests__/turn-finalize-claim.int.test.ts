import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER, type EngineEvent } from '@shared/engine';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { JobBootstrapService } from '../../job-bootstrap';
import { DB_CONNECTION } from '../../persistence/database.module';
import { TurnHarnessFactory } from '../../surface/turn-harness.service';
import { JobTitler } from '../../titling';
import { CLASSIFIER_LLM } from '../decision-gate';
import { TurnRegistry } from '../turn-registry.service';

const TEAM_ID = '55555555-5555-4555-8555-555555555555'; // sentinel org uuid (distinct from the sibling guard test)

describe('single-winner finalize claim (live Postgres row-locked delete)', () => {
  let app: NestExpressApplication;
  let registry: TurnRegistry;
  let harness: TurnHarnessFactory;
  let dataSource: DataSource;
  let jobA = '';
  let threadA = '';

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
    harness = app.get(TurnHarnessFactory);
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

    await dataSource.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID, 'claim-org', 'claim-org'],
    );
    const [repo] = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url) VALUES ($1,$2,$3,$4) RETURNING id`,
      [
        TEAM_ID,
        `claim-repo-${randomUUID().slice(0, 8)}`,
        'claim-repo',
        'https://example.invalid/r.git',
      ],
    );
    const [job] = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin) VALUES ($1,$2,$3) RETURNING id`,
      [TEAM_ID, repo.id, 'chat'],
    );
    jobA = job.id as string;
    const bootstrap = app.get(JobBootstrapService);
    await bootstrap.ensurePlanningThreadGroup(jobA, TEAM_ID);
    threadA = await bootstrap.planningThreadId(jobA);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) {
      await dataSource.query(`DELETE FROM active_turns WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM jobs WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM repos WHERE org_id = $1`, [TEAM_ID]);
      await dataSource.query(`DELETE FROM organizations WHERE id = $1`, [TEAM_ID]);
    }
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('lets exactly ONE of two concurrent finalizers win (the other loses); the row is gone', async () => {
    const turnId = randomUUID();
    await registry.register(reg(turnId, jobA, 'brain'));

    const [a, b] = await Promise.all([
      registry.finalize(turnId, 'done'),
      registry.finalize(turnId, 'done'),
    ]);

    expect([a, b].filter((won) => won === true)).toHaveLength(1);
    expect([a, b].filter((won) => won === false)).toHaveLength(1);
    expect(await registry.get(turnId)).toBeNull(); // the live row is gone (winner deleted it)
  });

  it('a claim LOSER that discards writes NOTHING — the same block is persisted once, not twice', async () => {
    const text = `winner-only-${randomUUID()}`;
    const textEvent: EngineEvent = { kind: 'text', text };

    const winner = harness.create({
      jobId: jobA,
      orgId: TEAM_ID,
      threadId: threadA,
      channel: 'repo-guard',
      lane: 'main',
    });
    const loser = harness.create({
      jobId: jobA,
      orgId: TEAM_ID,
      threadId: threadA,
      channel: 'repo-guard',
      lane: 'main',
    });
    winner.onEvent(textEvent);
    loser.onEvent(textEvent);

    await winner.finish();
    await loser.discard();

    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND kind = 'chat' AND text = $2`,
      [jobA, text],
    );
    expect(rows[0].n).toBe(1);
  });

  it('returns false for an UNREGISTERED turn (no row to delete)', async () => {
    expect(await registry.finalize(randomUUID(), 'done')).toBe(false);
  });

  it('returns false when finalizing an ALREADY-finalized turn (idempotent — row already gone)', async () => {
    const turnId = randomUUID();
    await registry.register(reg(turnId, jobA, 'brain'));

    expect(await registry.finalize(turnId, 'done')).toBe(true); // first finalize wins
    expect(await registry.finalize(turnId, 'done')).toBe(false); // second finds no row
  });
});
