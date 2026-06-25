import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { BRAIN_LLM } from '../brain';
import { CLASSIFIER_LLM } from '../decision-gate';
import { PLANNER_LLM } from '../driver';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
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
 * Boots the REAL AppModule (agent surface) against live Postgres, mocking only the external boundaries
 * (LLMs/engine/git/PR) — none are exercised here; we drive `BrainStoreService` directly.
 */
const TEAM_ID = '33333333-3333-4333-8333-333333333333'; // sentinel org uuid
const PROJECT_SLUG = 'brainstore-it';

describe('BrainStoreService re-propose (live Postgres)', () => {
  let app: NestExpressApplication;
  let store: BrainStoreService;
  let dataSource: DataSource;

  const prevSurface = process.env.SURFACE;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BRAIN_LLM)
      .useValue(new FakeBrainLlm())
      .overrideProvider(PLANNER_LLM)
      .useValue(new FakePlannerLlm())
      .overrideProvider(CLASSIFIER_LLM)
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
    dataSource = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    await purge(dataSource);
  }, 60_000);

  afterAll(async () => {
    if (dataSource) await purge(dataSource);
    await app?.close();
    if (prevSurface === undefined) delete process.env.SURFACE;
    else process.env.SURFACE = prevSurface;
  });

  it('a re-propose on the same scoping thread clears the prior draft instead of colliding', async () => {
    // The thread IS the build unit; sections/decision_records FK → threads.id, and threads.repo_id
    // FK → repos.id — so seed an org + repo, then anchor a real thread.
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, $2, 'BrainStore Repo', 'https://github.com/acme/brainstore.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID, PROJECT_SLUG],
    );
    const repoId = repoRow.id;
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO threads (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'rate limiting') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const threadId = thread.id;
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'rate limiting',
      kind: 'feature',
    });

    // First proposal — two sections at ordinals 10, 20.
    const first = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'rate limiting v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      sectionBriefs: ['backend middleware', 'frontend banner'],
    });
    expect(first.thread.status).toBe('awaiting_approval');
    expect(await sectionBriefs(dataSource, threadId)).toEqual([
      'backend middleware',
      'frontend banner',
    ]);

    // Human requests changes → back to scoping.
    await store.reopenScoping(threadId);

    // Second proposal on the SAME thread — fewer sections, re-using ordinal 10. Must NOT throw.
    const second = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'rate limiting v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      sectionBriefs: ['backend middleware only'],
    });

    expect(second.thread.status).toBe('awaiting_approval');
    expect(second.decisionRecordId).not.toBe(first.decisionRecordId);
    expect(second.thread.title).toBe('rate limiting v2');

    // Sections reflect ONLY the new proposal — the stale ones are gone.
    expect(await sectionBriefs(dataSource, threadId)).toEqual(['backend middleware only']);

    // The prior draft record is superseded; exactly one draft remains (the new one).
    expect(await recordStatus(dataSource, first.decisionRecordId)).toBe('superseded');
    expect(await recordStatus(dataSource, second.decisionRecordId)).toBe('draft');
    expect(await draftCount(dataSource, threadId)).toBe(1);
  }, 30_000);

  it('stamps appended blocks with their emission time so a mid-turn user message keeps chronological order', async () => {
    // Regression for the "a question I asked later jumped to the top of the turn" bug. The turn's blocks
    // are persisted in a batch at turn END, but the operator's follow-up is persisted immediately. Without
    // an emission-time stamp the whole batch would sort AFTER the follow-up (later INSERT time), pushing it
    // above the turn. `appendBlock(createdAt)` stamps each block with when it streamed, restoring order.
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-order-it', 'Order Repo', 'https://github.com/acme/order.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO threads (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'ordering') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const threadId = thread.id;
    const at = (sec: number) => new Date(Date.UTC(2026, 5, 24, 0, 0, sec));

    // The turn-1 question (persisted first).
    await insertUserMessage(dataSource, threadId, 'first question', at(0));
    // The turn streams two blocks — captured at emission times 1s and 2s into the turn…
    await store.appendBlock(threadId, { kind: 'chat', text: 'investigating', createdAt: at(1) });
    await store.appendBlock(threadId, { kind: 'chat', text: 'here is the answer', createdAt: at(2) });
    // …but the operator's follow-up landed (real send time, 3s in) BEFORE the blocks were written at turn
    // end. Inserted AFTER the blocks here on purpose, to mirror the real INSERT order that caused the bug.
    await insertUserMessage(dataSource, threadId, 'later question', at(3));

    expect(await messageTexts(dataSource, threadId)).toEqual([
      'first question',
      'investigating',
      'here is the answer',
      'later question',
    ]);
  }, 30_000);
});

async function insertUserMessage(
  ds: DataSource,
  threadId: string,
  text: string,
  createdAt: Date,
): Promise<void> {
  await ds.query(
    `INSERT INTO messages (thread_id, author, author_id, text, kind, created_at, updated_at)
       VALUES ($1, 'Operator', 'op', $2, 'chat', $3, $3)`,
    [threadId, text, createdAt.toISOString()],
  );
}

async function messageTexts(ds: DataSource, threadId: string): Promise<string[]> {
  const rows: Array<{ text: string }> = await ds.query(
    `SELECT text FROM messages WHERE thread_id = $1 ORDER BY created_at ASC`,
    [threadId],
  );
  return rows.map((r) => r.text);
}

async function sectionBriefs(ds: DataSource, threadId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM sections WHERE thread_id = $1 ORDER BY ordinal ASC`,
    [threadId],
  );
  return rows.map((r) => r.brief);
}

async function recordStatus(ds: DataSource, recordId: string): Promise<string | null> {
  const rows: Array<{ status: string }> = await ds.query(
    `SELECT status FROM decision_records WHERE id = $1`,
    [recordId],
  );
  return rows[0]?.status ?? null;
}

async function draftCount(ds: DataSource, threadId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::int AS n FROM decision_records WHERE thread_id = $1 AND status = 'draft'`,
    [threadId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Delete every row this test's synthetic tenant owns (FK cascade from threads/org does the rest). */
async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM threads WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
