import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { ATLAS_BRAIN_LLM } from '../brain';
import { ATLAS_CLASSIFIER_LLM } from '../decision-gate';
import { ATLAS_PLANNER_LLM } from '../driver';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AtlasModule } from '../atlas.module';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  FakeBrainLlm,
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakePlannerLlm,
} from '../e2e/e2e-stubs';
import { BrainStoreService } from './brain-store.service';

/**
 * Int test for the request-changes / RE-PROPOSE path (issue #0). A rejected plan flips the job back to
 * `scoping` (`reopenScoping`) and the grill proposes again, re-running `persistPlan` on the SAME job.
 * Sections are gap-numbered from 10 each time, so without clearing the prior draft the second proposal
 * collides on `UNIQUE(job_id, ordinal)`. This proves `persistPlan` is now self-consistent: it deletes
 * the prior sections and supersedes the prior draft record, so a re-propose succeeds cleanly.
 *
 * Boots the REAL AtlasModule (agent surface) against live Postgres, mocking only the external boundaries
 * (LLMs/engine/git/PR) — none are exercised here; we drive `BrainStoreService` directly.
 */
const TEAM_ID = 'T-BRAINSTORE-IT';
const PROJECT_ID = 'brainstore-it';

describe('BrainStoreService re-propose (live Postgres)', () => {
  let app: NestExpressApplication;
  let store: BrainStoreService;
  let dataSource: DataSource;

  const prevSurface = process.env.ATLAS_SURFACE;

  beforeAll(async () => {
    process.env.ATLAS_SURFACE = 'agent';

    const moduleRef = await Test.createTestingModule({ imports: [AtlasModule] })
      .overrideProvider(ATLAS_BRAIN_LLM)
      .useValue(new FakeBrainLlm())
      .overrideProvider(ATLAS_PLANNER_LLM)
      .useValue(new FakePlannerLlm())
      .overrideProvider(ATLAS_CLASSIFIER_LLM)
      .useValue(new FakeClassifierLlm())
      .overrideProvider(ENGINE_RUNNER)
      .useValue(new FakeEngineRunner())
      .overrideProvider(LocalGitService)
      .useValue(new FakeLocalGitService())
      .overrideProvider(GithubPrService)
      .useValue(new FakeGithubPrService())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    app.enableShutdownHooks();
    await app.init();

    store = app.get(BrainStoreService);
    dataSource = app.get<DataSource>(getDataSourceToken(ATLAS_CONNECTION));
    await purge(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) await purge(dataSource);
    await app?.close();
    if (prevSurface === undefined) delete process.env.ATLAS_SURFACE;
    else process.env.ATLAS_SURFACE = prevSurface;
  });

  it('a re-propose on the same scoping job clears the prior draft instead of colliding', async () => {
    // atlas_jobs.thread_id FK → atlas_threads.id, so anchor a real thread first.
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO atlas_threads (team_id, project_id, origin, title)
         VALUES ($1, $2, 'chat', 'rate limiting') RETURNING id`,
      [TEAM_ID, PROJECT_ID],
    );
    const threadId = thread.id;
    const jobId = await store.openJob({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      threadId,
      title: 'rate limiting',
      kind: 'feature',
    });

    // First proposal — two sections at ordinals 10, 20.
    const first = await store.persistPlan({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      jobId,
      title: 'rate limiting v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      sectionBriefs: ['backend middleware', 'frontend banner'],
    });
    expect(first.job.status).toBe('awaiting_approval');
    expect(await sectionBriefs(dataSource, jobId)).toEqual([
      'backend middleware',
      'frontend banner',
    ]);

    // Human requests changes → back to scoping.
    await store.reopenScoping(jobId);

    // Second proposal on the SAME job — fewer sections, re-using ordinal 10. Must NOT throw.
    const second = await store.persistPlan({
      teamId: TEAM_ID,
      projectId: PROJECT_ID,
      jobId,
      title: 'rate limiting v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      sectionBriefs: ['backend middleware only'],
    });

    expect(second.job.status).toBe('awaiting_approval');
    expect(second.decisionRecordId).not.toBe(first.decisionRecordId);
    expect(second.job.title).toBe('rate limiting v2');

    // Sections reflect ONLY the new proposal — the stale ones are gone.
    expect(await sectionBriefs(dataSource, jobId)).toEqual(['backend middleware only']);

    // The prior draft record is superseded; exactly one draft remains (the new one).
    expect(await recordStatus(dataSource, first.decisionRecordId)).toBe('superseded');
    expect(await recordStatus(dataSource, second.decisionRecordId)).toBe('draft');
    expect(await draftCount(dataSource, jobId)).toBe(1);
  }, 30_000);
});

async function sectionBriefs(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM atlas_sections WHERE job_id = $1 ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.brief);
}

async function recordStatus(ds: DataSource, recordId: string): Promise<string | null> {
  const rows: Array<{ status: string }> = await ds.query(
    `SELECT status FROM atlas_decision_records WHERE id = $1`,
    [recordId],
  );
  return rows[0]?.status ?? null;
}

async function draftCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::int AS n FROM atlas_decision_records WHERE job_id = $1 AND status = 'draft'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Delete every row this test's synthetic tenant owns. */
async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM atlas_phases WHERE team_id = $1`);
  await q(`DELETE FROM atlas_sections WHERE team_id = $1`);
  await q(`DELETE FROM atlas_decision_records WHERE team_id = $1`);
  await q(`DELETE FROM atlas_jobs WHERE team_id = $1`);
  await q(`DELETE FROM atlas_threads WHERE team_id = $1`);
  await q(`DELETE FROM atlas_teams WHERE team_id = $1`);
}
