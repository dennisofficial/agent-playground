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
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { ThreadTitler } from '../titling';
import { BrainStoreService } from './brain-store.service';

/**
 * Int test for the request-changes / RE-PROPOSE path (issue #0). A rejected plan flips the job back to
 * `scoping` (`reopenScoping`) and the grill proposes again, re-running `persistPlan` on the SAME job.
 * Sections are gap-numbered from 10 each time, so without clearing the prior draft the second proposal
 * collides on `UNIQUE(job_id, ordinal)`. This proves `persistPlan` is now self-consistent: it deletes
 * the prior tracks and supersedes the prior draft record, so a re-propose succeeds cleanly.
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
      .overrideProvider(ThreadTitler)
      .useValue(new FakeThreadTitler())
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
    // The thread IS the build unit; tracks/decision_records FK → threads.id, and threads.repo_id
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

    // First proposal — two tracks at ordinals 10, 20.
    const first = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'rate limiting v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      trackTitles: ['backend middleware', 'frontend banner'],
    });
    expect(first.thread.status).toBe('awaiting_approval');
    expect(await trackTitles(dataSource, threadId)).toEqual([
      'backend middleware',
      'frontend banner',
    ]);

    // Human requests changes → back to scoping.
    await store.reopenScoping(threadId);

    // Second proposal on the SAME thread — fewer tracks, re-using ordinal 10. Must NOT throw.
    const second = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'rate limiting v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      trackTitles: ['backend middleware only'],
    });

    expect(second.thread.status).toBe('awaiting_approval');
    expect(second.decisionRecordId).not.toBe(first.decisionRecordId);
    expect(second.thread.title).toBe('rate limiting v2');

    // Sections reflect ONLY the new proposal — the stale ones are gone.
    expect(await trackTitles(dataSource, threadId)).toEqual(['backend middleware only']);

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

  it('createFollowUpThread persists a plain open thread on the repo (the create_thread tool)', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-ct-it', 'CT Repo', 'https://github.com/acme/ct.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const repoId = repoRow.id;

    const followUpId = await store.createFollowUpThread({
      orgId: TEAM_ID,
      repoId,
      title: 'follow-up',
      baseBranch: 'main',
    });
    const row = await loadThreadRow(dataSource, followUpId);
    expect(row).toMatchObject({ status: 'open', origin: 'control', title: 'follow-up', base_branch: 'main' });
  }, 30_000);

  it('CRUDs decisions in the working set by stable id and reads them back via the answered card', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-decisions-it', 'Dec Repo', 'https://github.com/acme/dec.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO threads (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'subdomains') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const threadId = thread.id;

    // A posted-then-answered question card.
    await store.appendCardMessage(threadId, {
      ts: 'q-1',
      text: 'Editable or fixed?',
      card: { type: 'question_card', threadId, questionId: 'q-1', question: 'Editable or fixed?', options: [] },
    });
    await store.updateCardMessage(threadId, 'q-1', { answer: 'Editable', answeredAt: '2026-06-26T00:00:00Z' });
    const answered = await store.latestAnsweredQuestionCard(threadId);
    expect((answered?.card as { answer?: string } | null)?.answer).toBe('Editable');

    // CREATE two decisions → stable sequential ids d1, d2 (id-addressed, not class+title keyed).
    const first = await store.createDecision(threadId, {
      decisionClass: 'data_model',
      title: 'Subdomain',
      ruling: 'fixed at checkout',
    });
    expect(first.decision.id).toBe('d1');
    const second = await store.createDecision(threadId, {
      decisionClass: 'data_model',
      title: 'Subdomain', // same class+title is allowed now (distinct ids)
      ruling: 'editable in Network tab',
      question: 'Editable or fixed?',
      answer: 'Editable',
    });
    expect(second.decision.id).toBe('d2');
    expect(second.all).toHaveLength(2);

    // UPDATE by id revises just that row.
    const updated = await store.updateDecision(threadId, 'd1', { ruling: 'fixed (final)' });
    expect(updated?.decision).toMatchObject({ id: 'd1', ruling: 'fixed (final)' });
    expect(await store.updateDecision(threadId, 'd9', { ruling: 'x' })).toBeNull(); // unknown id

    // DELETE by id; the next create does NOT reuse the freed id (max-based allocation).
    const del = await store.deleteDecision(threadId, 'd1');
    expect(del.removed).toBe(true);
    expect(del.all.map((d) => d.id)).toEqual(['d2']);
    expect((await store.deleteDecision(threadId, 'd1')).removed).toBe(false); // already gone
    const third = await store.createDecision(threadId, {
      decisionClass: 'api_contract',
      title: 'Pagination',
      ruling: 'cursor-based',
    });
    expect(third.decision.id).toBe('d3'); // not d1

    expect(await store.pendingDecisions(threadId)).toHaveLength(2);

    // Consuming the card flags it so latestAnsweredQuestionCard skips it next time.
    await store.updateCardMessage(threadId, 'q-1', { loggedDecision: true });
    expect(await store.latestAnsweredQuestionCard(threadId)).toBeNull();
  }, 30_000);

  it('persistPlan with stepsByTrack locks step rows + sets track.plan; clears them on re-propose; omitting it creates none', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-steps-it', 'Phases Repo', 'https://github.com/acme/steps.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const repoId = repoRow.id;
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO threads (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'authored') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const threadId = thread.id;
    await store.openJob({ orgId: TEAM_ID, repoId, threadId, title: 'authored', kind: 'feature' });

    // Full-plan-up-front: 2 tracks, the first with 2 authored steps, the second with 1.
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'authored v1',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      trackTitles: ['backend', 'frontend'],
      stepsByTrack: [
        [
          { title: 'model', brief: 'add the entity at server.entity.ts:1' },
          { title: 'service', brief: 'add the service at server.service.ts:1' },
        ],
        [{ title: 'page', brief: 'add the page at page.tsx:1' }],
      ],
    });

    // Step rows locked: 2 under the first track, 1 under the second, gap-numbered + pending/build.
    const phases1 = await phasesFor(dataSource, threadId);
    expect(phases1.map((p) => p.brief)).toEqual([
      'add the entity at server.entity.ts:1',
      'add the service at server.service.ts:1',
      'add the page at page.tsx:1',
    ]);
    expect(phases1.every((p) => p.status === 'pending' && p.stage === 'build')).toBe(true);
    // track.plan is set on BOTH tracks (so the pipeline view reports hasPlan).
    const plans1 = await sectionPlans(dataSource, threadId);
    expect(plans1.every((p) => p != null && p.length > 0)).toBe(true);

    // Re-propose WITHOUT stepsByTrack (e.g. a direct-build-style re-shape): prior step rows are
    // cascade-cleared with their tracks, and no new step rows are created.
    await store.reopenScoping(threadId);
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      threadId,
      title: 'authored v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      trackTitles: ['backend only'],
    });

    expect(await phasesFor(dataSource, threadId)).toHaveLength(0);
    const plans2 = await sectionPlans(dataSource, threadId);
    expect(plans2).toEqual([null]); // one track, no plan (no authored steps this time)
  }, 30_000);

  it('the human-input gate: openQuestion is atomic + one-at-a-time, and answered→delivered drives boot recovery', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-gate-it', 'Gate Repo', 'https://github.com/acme/gate.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const repoId = repoRow.id;
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO threads (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'gate') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const threadId = thread.id;
    const mkCard = (id: string, q: string) => ({
      ts: id,
      text: q,
      card: { type: 'question_card', threadId, questionId: id, question: q, options: [] },
    });

    // open q-1 → card row + gate pointer commit together (atomic).
    expect(await store.openQuestion(threadId, mkCard('q-1', 'Editable or fixed?'))).toEqual({ ok: true });
    expect(await awaitingId(dataSource, threadId)).toBe('q-1');
    expect((await store.getQuestionCard(threadId, 'q-1'))?.question).toBe('Editable or fixed?');

    // a second question while q-1 is UNANSWERED is refused (one open question at a time); pointer holds.
    expect(await store.openQuestion(threadId, mkCard('q-2', 'Which region?'))).toEqual({
      ok: false,
      alreadyOpen: true,
    });
    expect(await awaitingId(dataSource, threadId)).toBe('q-1');
    expect(await store.getQuestionCard(threadId, 'q-2')).toBeNull(); // never persisted

    // operator answers q-1 → it becomes an answered-but-undelivered question the boot sweep recovers.
    await store.updateCardMessage(threadId, 'q-1', { answer: 'Editable', answeredAt: '2026-06-27T00:00:00Z' });
    expect(await store.findUndeliveredAnsweredQuestions()).toContainEqual({
      threadId,
      orgId: TEAM_ID,
      repoId,
      questionId: 'q-1',
      question: 'Editable or fixed?',
      answer: 'Editable',
    });

    // a delivery turn stamps delivered; the pointer clear is compare-and-clear (a stale id no-ops).
    await store.markQuestionDelivered(threadId, 'q-1');
    await store.clearAwaitingQuestion(threadId, 'not-q-1');
    expect(await awaitingId(dataSource, threadId)).toBe('q-1'); // wrong id → unchanged
    await store.clearAwaitingQuestion(threadId, 'q-1');
    expect(await awaitingId(dataSource, threadId)).toBeNull();

    // once delivered (deliveredAt set + pointer cleared) it's no longer a recovery candidate.
    expect((await store.getQuestionCard(threadId, 'q-1'))?.deliveredAt).toBeTruthy();
    expect(
      (await store.findUndeliveredAnsweredQuestions()).some((q) => q.threadId === threadId),
    ).toBe(false);
  }, 30_000);
});

async function awaitingId(ds: DataSource, threadId: string): Promise<string | null> {
  const rows: Array<{ awaiting_question_id: string | null }> = await ds.query(
    `SELECT awaiting_question_id FROM threads WHERE id = $1`,
    [threadId],
  );
  return rows[0]?.awaiting_question_id ?? null;
}

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

async function trackTitles(ds: DataSource, threadId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM tracks WHERE thread_id = $1 ORDER BY ordinal ASC`,
    [threadId],
  );
  return rows.map((r) => r.brief);
}

async function phasesFor(
  ds: DataSource,
  threadId: string,
): Promise<Array<{ brief: string; status: string; stage: string; batch_ordinal: number | null }>> {
  return ds.query(
    `SELECT p.brief, p.status, p.stage, p.batch_ordinal
       FROM steps p JOIN tracks s ON s.id = p.track_id
      WHERE s.thread_id = $1 ORDER BY s.ordinal ASC, p.ordinal ASC`,
    [threadId],
  );
}

async function sectionPlans(ds: DataSource, threadId: string): Promise<Array<string | null>> {
  const rows: Array<{ plan: string | null }> = await ds.query(
    `SELECT plan FROM tracks WHERE thread_id = $1 ORDER BY ordinal ASC`,
    [threadId],
  );
  return rows.map((r) => r.plan);
}

async function loadThreadRow(
  ds: DataSource,
  threadId: string,
): Promise<{ status: string; origin: string; title: string | null; base_branch: string | null } | null> {
  const rows: Array<{ status: string; origin: string; title: string | null; base_branch: string | null }> =
    await ds.query(`SELECT status, origin, title, base_branch FROM threads WHERE id = $1`, [threadId]);
  return rows[0] ?? null;
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
