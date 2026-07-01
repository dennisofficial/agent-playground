import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { PLANNER_LLM } from '../driver';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakePlannerLlm,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { BrainStoreService } from './brain-store.service';

/**
 * Int test for the request-changes / RE-PROPOSE path (issue #0). A rejected plan flips the job back to
 * `planning` (`reopenPlanning`) and the grill proposes again, re-running `persistPlan` on the SAME job.
 * Sections are gap-numbered from 10 each time, so without clearing the prior draft the second proposal
 * collides on `UNIQUE(job_id, ordinal)`. This proves `persistPlan` is now self-consistent: it deletes
 * the prior threads and supersedes the prior draft record, so a re-propose succeeds cleanly.
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
      .overrideProvider(JobTitler)
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

  it('a re-propose on the same planning thread clears the prior draft instead of colliding', async () => {
    // The thread IS the build unit; threads/decision_records FK → jobs.id, and jobs.repo_id
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
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'rate limiting') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = thread.id;
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'rate limiting',
      kind: 'feature',
    });

    // First proposal — two threads at ordinals 10, 20.
    const first = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'rate limiting v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      threadTitles: ['backend middleware', 'frontend banner'],
    });
    expect(first.thread.status).toBe('awaiting_approval');
    expect(await threadTitles(dataSource, jobId)).toEqual([
      'backend middleware',
      'frontend banner',
    ]);

    // Human requests changes → back to planning.
    await store.reopenPlanning(jobId);

    // Second proposal on the SAME thread — fewer threads, re-using ordinal 10. Must NOT throw.
    const second = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'rate limiting v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      threadTitles: ['backend middleware only'],
    });

    expect(second.thread.status).toBe('awaiting_approval');
    expect(second.decisionRecordId).not.toBe(first.decisionRecordId);
    expect(second.thread.title).toBe('rate limiting v2');

    // Sections reflect ONLY the new proposal — the stale ones are gone.
    expect(await threadTitles(dataSource, jobId)).toEqual(['backend middleware only']);

    // The prior draft record is superseded; exactly one draft remains (the new one).
    expect(await recordStatus(dataSource, first.decisionRecordId)).toBe('superseded');
    expect(await recordStatus(dataSource, second.decisionRecordId)).toBe('draft');
    expect(await draftCount(dataSource, jobId)).toBe(1);
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
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'ordering') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const jobId = thread.id;
    const at = (sec: number) => new Date(Date.UTC(2026, 5, 24, 0, 0, sec));

    // The turn-1 question (persisted first).
    await insertUserMessage(dataSource, jobId, 'first question', at(0));
    // The turn streams two blocks — captured at emission times 1s and 2s into the turn…
    await store.appendBlock(jobId, { kind: 'chat', text: 'investigating', createdAt: at(1) });
    await store.appendBlock(jobId, { kind: 'chat', text: 'here is the answer', createdAt: at(2) });
    // …but the operator's follow-up landed (real send time, 3s in) BEFORE the blocks were written at turn
    // end. Inserted AFTER the blocks here on purpose, to mirror the real INSERT order that caused the bug.
    await insertUserMessage(dataSource, jobId, 'later question', at(3));

    expect(await messageTexts(dataSource, jobId)).toEqual([
      'first question',
      'investigating',
      'here is the answer',
      'later question',
    ]);
  }, 30_000);

  it('createFollowUpJob persists a plain open thread on the repo (the create_job tool)', async () => {
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

    const followUpId = await store.createFollowUpJob({
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
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'subdomains') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const jobId = thread.id;

    // A posted-then-answered question card.
    await store.appendCardMessage(jobId, {
      ts: 'q-1',
      text: 'Editable or fixed?',
      card: { type: 'question_card', jobId, questionId: 'q-1', question: 'Editable or fixed?', options: [] },
    });
    await store.updateCardMessage(jobId, 'q-1', { answer: 'Editable', answeredAt: '2026-06-26T00:00:00Z' });
    const answered = await store.latestAnsweredQuestionCard(jobId);
    expect((answered?.card as { answer?: string } | null)?.answer).toBe('Editable');

    // CREATE two decisions → stable sequential ids d1, d2 (id-addressed, not class+title keyed).
    const first = await store.createDecision(jobId, {
      decisionClass: 'data_model',
      title: 'Subdomain',
      ruling: 'fixed at checkout',
    });
    expect(first.decision.id).toBe('d1');
    const second = await store.createDecision(jobId, {
      decisionClass: 'data_model',
      title: 'Subdomain', // same class+title is allowed now (distinct ids)
      ruling: 'editable in Network tab',
      question: 'Editable or fixed?',
      answer: 'Editable',
    });
    expect(second.decision.id).toBe('d2');
    expect(second.all).toHaveLength(2);

    // UPDATE by id revises just that row.
    const updated = await store.updateDecision(jobId, 'd1', { ruling: 'fixed (final)' });
    expect(updated?.decision).toMatchObject({ id: 'd1', ruling: 'fixed (final)' });
    expect(await store.updateDecision(jobId, 'd9', { ruling: 'x' })).toBeNull(); // unknown id

    // DELETE by id; the next create does NOT reuse the freed id (max-based allocation).
    const del = await store.deleteDecision(jobId, 'd1');
    expect(del.removed).toBe(true);
    expect(del.all.map((d) => d.id)).toEqual(['d2']);
    expect((await store.deleteDecision(jobId, 'd1')).removed).toBe(false); // already gone
    const third = await store.createDecision(jobId, {
      decisionClass: 'api_contract',
      title: 'Pagination',
      ruling: 'cursor-based',
    });
    expect(third.decision.id).toBe('d3'); // not d1

    expect(await store.pendingDecisions(jobId)).toHaveLength(2);

    // Consuming the card flags it so latestAnsweredQuestionCard skips it next time.
    await store.updateCardMessage(jobId, 'q-1', { loggedDecision: true });
    expect(await store.latestAnsweredQuestionCard(jobId)).toBeNull();
  }, 30_000);

  it('persistPlan with stepsByThread locks step rows + sets thread.plan; clears them on re-propose; omitting it creates none', async () => {
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
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'authored') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = thread.id;
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'authored', kind: 'feature' });

    // Full-plan-up-front: 2 threads, the first with 2 authored steps, the second with 1.
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'authored v1',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      threadTitles: ['backend', 'frontend'],
      stepsByThread: [
        [
          { title: 'model', brief: 'add the entity at server.entity.ts:1' },
          { title: 'service', brief: 'add the service at server.service.ts:1' },
        ],
        [{ title: 'page', brief: 'add the page at page.tsx:1' }],
      ],
    });

    // Step rows locked: 2 under the first thread, 1 under the second, gap-numbered + pending/build.
    const phases1 = await phasesFor(dataSource, jobId);
    expect(phases1.map((p) => p.brief)).toEqual([
      'add the entity at server.entity.ts:1',
      'add the service at server.service.ts:1',
      'add the page at page.tsx:1',
    ]);
    expect(phases1.every((p) => p.status === 'pending' && p.stage === 'build')).toBe(true);
    // thread.plan is set on BOTH threads (so the pipeline view reports hasPlan).
    const plans1 = await sectionPlans(dataSource, jobId);
    expect(plans1.every((p) => p != null && p.length > 0)).toBe(true);

    // Re-propose WITHOUT stepsByThread (e.g. a direct-build-style re-shape): prior step rows are
    // cascade-cleared with their threads, and no new step rows are created.
    await store.reopenPlanning(jobId);
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'authored v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      threadTitles: ['backend only'],
    });

    expect(await phasesFor(dataSource, jobId)).toHaveLength(0);
    const plans2 = await sectionPlans(dataSource, jobId);
    expect(plans2).toEqual([null]); // one thread, no plan (no authored steps this time)
  }, 30_000);

  it('the human-input gate: openQuestion stacks (counter), markQuestionAnswered is atomic/idempotent, answered→delivered drives boot recovery', async () => {
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
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'gate') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = thread.id;
    const mkCard = (id: string, q: string) => ({
      ts: id,
      text: q,
      card: { type: 'question_card', jobId, questionId: id, question: q, options: [] },
    });

    // open q-1 → card row + counter bump commit together (atomic).
    expect(await store.openQuestion(jobId, mkCard('q-1', 'Editable or fixed?'))).toEqual({ ok: true });
    expect(await openCount(dataSource, jobId)).toBe(1);
    expect((await store.getQuestionCard(jobId, 'q-1'))?.question).toBe('Editable or fixed?');

    // STACKING: a second question while q-1 is unanswered is allowed — counter goes to 2, both persist.
    expect(await store.openQuestion(jobId, mkCard('q-2', 'Which region?'))).toEqual({ ok: true });
    expect(await openCount(dataSource, jobId)).toBe(2);
    expect((await store.getQuestionCard(jobId, 'q-2'))?.question).toBe('Which region?');

    // answer q-1 (out of order is fine) → first answer wins + decrements; a second answer is idempotent.
    expect(await store.markQuestionAnswered(jobId, 'q-1', 'Editable')).toEqual({ firstAnswer: true });
    expect(await store.markQuestionAnswered(jobId, 'q-1', 'Editable-again')).toEqual({ firstAnswer: false });
    expect(await openCount(dataSource, jobId)).toBe(1); // only the winning answer decremented
    expect((await store.getQuestionCard(jobId, 'q-1'))?.answer).toBe('Editable'); // not overwritten

    // q-1 is now answered-but-undelivered → the boot sweep recovers it (scans card rows, not a pointer).
    expect(await store.findUndeliveredAnsweredQuestions()).toContainEqual(
      expect.objectContaining({ jobId, orgId: TEAM_ID, repoId, questionId: 'q-1', answer: 'Editable' }),
    );

    // a delivery turn stamps q-1 delivered → no longer a recovery candidate; q-2 (unanswered) is not one either.
    await store.markQuestionDelivered(jobId, 'q-1');
    expect((await store.getQuestionCard(jobId, 'q-1'))?.deliveredAt).toBeTruthy();
    expect(
      (await store.findUndeliveredAnsweredQuestions()).some((q) => q.jobId === jobId),
    ).toBe(false);

    // reconcile recomputes the counter from the actual unanswered cards (q-2 only) — heals any drift.
    await dataSource.query(`UPDATE jobs SET open_question_count = 99 WHERE id = $1`, [jobId]);
    await store.reconcileOpenQuestionCounts();
    expect(await openCount(dataSource, jobId)).toBe(1); // q-2 still unanswered
  }, 30_000);
});

async function openCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ open_question_count: number }> = await ds.query(
    `SELECT open_question_count FROM jobs WHERE id = $1`,
    [jobId],
  );
  return Number(rows[0]?.open_question_count ?? -1);
}

async function insertUserMessage(
  ds: DataSource,
  jobId: string,
  text: string,
  createdAt: Date,
): Promise<void> {
  await ds.query(
    `INSERT INTO messages (job_id, author, author_id, text, kind, created_at, updated_at)
       VALUES ($1, 'Operator', 'op', $2, 'chat', $3, $3)`,
    [jobId, text, createdAt.toISOString()],
  );
}

async function messageTexts(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ text: string }> = await ds.query(
    `SELECT text FROM messages WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return rows.map((r) => r.text);
}

async function threadTitles(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM threads WHERE job_id = $1 ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.brief);
}

async function phasesFor(
  ds: DataSource,
  jobId: string,
): Promise<Array<{ brief: string; status: string; stage: string; batch_ordinal: number | null }>> {
  return ds.query(
    `SELECT p.brief, p.status, p.stage, p.batch_ordinal
       FROM steps p JOIN threads s ON s.id = p.thread_id
      WHERE s.job_id = $1 ORDER BY s.ordinal ASC, p.ordinal ASC`,
    [jobId],
  );
}

async function sectionPlans(ds: DataSource, jobId: string): Promise<Array<string | null>> {
  const rows: Array<{ plan: string | null }> = await ds.query(
    `SELECT plan FROM threads WHERE job_id = $1 ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.plan);
}

async function loadThreadRow(
  ds: DataSource,
  jobId: string,
): Promise<{ status: string; origin: string; title: string | null; base_branch: string | null } | null> {
  const rows: Array<{ status: string; origin: string; title: string | null; base_branch: string | null }> =
    await ds.query(`SELECT status, origin, title, base_branch FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}

async function recordStatus(ds: DataSource, recordId: string): Promise<string | null> {
  const rows: Array<{ status: string }> = await ds.query(
    `SELECT status FROM decision_records WHERE id = $1`,
    [recordId],
  );
  return rows[0]?.status ?? null;
}

async function draftCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::int AS n FROM decision_records WHERE job_id = $1 AND status = 'draft'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Delete every row this test's synthetic tenant owns (FK cascade from jobs/org does the rest). */
async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM jobs WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
