import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER, type EngineEvent } from '@shared/engine';
import { GithubPrService, LocalGitService } from '../git';
import { TurnHarnessFactory } from '../surface/turn-harness.service';
import { JobBootstrapService } from '../job-bootstrap';
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
import { TurnRegistry } from './turn-registry.service';

/**
 * Int test for the single-winner `finalize()` claim (Thread 1). Proves at the REAL DB that when two
 * attachers race to finish the same `turn_id` (two replicas mid rolling-deploy, or a same-process
 * boot-sweep/watchdog race), Postgres row-locks the concurrent deletes so exactly ONE `finalize` returns
 * `true` (the winner persists) and the other returns `false` (the loser persists nothing).
 *
 * Boots the REAL AppModule against live Postgres, mocking only external boundaries (none are exercised).
 */
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

    // Seed the FK chain: org → repo → job (active_turns.job_id → jobs.id).
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
    // messages.thread_id is NOT NULL (FK → threads.id) — seed the job's planning thread group + thread so the
    // harness blocks below anchor onto a real thread.
    const bootstrap = app.get(JobBootstrapService);
    await bootstrap.ensurePlanningThreadGroup(jobA, TEAM_ID);
    threadA = await bootstrap.planningThreadId(jobA);
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

  it('lets exactly ONE of two concurrent finalizers win (the other loses); the row is gone', async () => {
    const turnId = randomUUID();
    await registry.register(reg(turnId, jobA, 'brain'));

    // Two attachers finish the same registered turn at once — Postgres row-locks the deletes.
    const [a, b] = await Promise.all([
      registry.finalize(turnId, 'done'),
      registry.finalize(turnId, 'done'),
    ]);

    expect([a, b].filter((won) => won === true)).toHaveLength(1);
    expect([a, b].filter((won) => won === false)).toHaveLength(1);
    expect(await registry.get(turnId)).toBeNull(); // the live row is gone (winner deleted it)
  });

  it('a claim LOSER that discards writes NOTHING — the same block is persisted once, not twice', async () => {
    // Simulate the prod bug at the transcript layer: two attachers process the SAME turn, each with its own
    // harness streamer, and feed both the SAME chat block. The winner (claimed=true) finishes → persists; the
    // loser (claimed=false) discards → persists nothing. So `messages` ends with exactly ONE copy of the block.
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

    // The caller gates on the claim: winner persists, loser discards (mirrors `AgentSessionManager.lost`).
    await winner.finish();
    await loser.discard();

    const rows = await dataSource.query(
      `SELECT count(*)::int AS n FROM transcript_messages WHERE job_id = $1 AND kind = 'chat' AND text = $2`,
      [jobA, text],
    );
    expect(rows[0].n).toBe(1);
  });

  it('returns false for an UNREGISTERED turn (no row to delete)', async () => {
    // A turn that never registered has no `active_turns` row, so its DELETE affects nothing ⇒ false at the
    // registry level. NOTE: `runAttached` maps this case to claimed=true via its `wasRegistered` guard — a
    // sole-finisher unregistered turn is not a race loser and MUST still persist. This test stays at the
    // registry level (no runner boot): it asserts only the row-level truth, not the runner's remapping.
    expect(await registry.finalize(randomUUID(), 'done')).toBe(false);
  });

  it('returns false when finalizing an ALREADY-finalized turn (idempotent — row already gone)', async () => {
    const turnId = randomUUID();
    await registry.register(reg(turnId, jobA, 'brain'));

    expect(await registry.finalize(turnId, 'done')).toBe(true); // first finalize wins
    expect(await registry.finalize(turnId, 'done')).toBe(false); // second finds no row
  });
});
