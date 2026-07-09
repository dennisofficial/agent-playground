import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
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
    // A full plan (threadTitles.length > 0) appends exactly ONE master-review thread after the features.
    expect(await masterReviewCount(dataSource, jobId)).toBe(1);

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

  it('openJob anchors the thread into planning without clobbering an existing title when no title is given', async () => {
    // Regression: `review_plan` anchors the scoping job with an EMPTY title (goal/overview go to
    // propose_plan, not review). openJob must keep the thread's existing title in that case instead of
    // overwriting it with a placeholder — the authoritative rename happens later in persistPlan.
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
         VALUES ($1, $2, 'chat', 'Discuss next feature') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = thread.id;

    // Empty title → status flips to planning but the existing title is preserved.
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: '', kind: 'feature' });
    let row = await loadThreadRow(dataSource, jobId);
    expect(row?.status).toBe('planning');
    expect(row?.title).toBe('Discuss next feature');

    // Whitespace-only title is treated the same (no clobber).
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: '   ', kind: 'feature' });
    row = await loadThreadRow(dataSource, jobId);
    expect(row?.title).toBe('Discuss next feature');

    // A meaningful title still updates (propose_plan / direct-build path — the rename feature works).
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'Profile picture CRUD', kind: 'feature' });
    row = await loadThreadRow(dataSource, jobId);
    expect(row?.title).toBe('Profile picture CRUD');
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

    // OPEN-CARD SURFACING: only q-2 is still open (q-1 answered) → it's what the brain gets re-surfaced.
    const open1 = await store.openQuestionCards(jobId);
    expect(open1.map((c) => c.questionId)).toEqual(['q-2']);

    // WITHDRAW q-2 → terminal, decrements the counter, drops out of the open list.
    expect(await store.withdrawQuestion(jobId, 'q-2', 'reworded')).toEqual({ withdrawn: true });
    expect(await openCount(dataSource, jobId)).toBe(0);
    expect((await store.getQuestionCard(jobId, 'q-2'))?.withdrawnAt).toBeTruthy();
    expect((await store.getQuestionCard(jobId, 'q-2'))?.withdrawnReason).toBe('reworded');
    expect(await store.openQuestionCards(jobId)).toEqual([]);

    // Idempotent: a second withdraw is a no-op; an answer racing in after withdrawal must NOT fire.
    expect(await store.withdrawQuestion(jobId, 'q-2', 'again')).toEqual({ withdrawn: false });
    expect(await store.markQuestionAnswered(jobId, 'q-2', 'too late')).toEqual({ firstAnswer: false });
    expect(await openCount(dataSource, jobId)).toBe(0); // no double-decrement, no phantom answer

    // A withdrawn (unanswered) card is not a boot-recovery candidate, and reconcile ignores it.
    expect(
      (await store.findUndeliveredAnsweredQuestions()).some((q) => q.questionId === 'q-2'),
    ).toBe(false);
    await dataSource.query(`UPDATE jobs SET open_question_count = 42 WHERE id = $1`, [jobId]);
    await store.reconcileOpenQuestionCounts();
    expect(await openCount(dataSource, jobId)).toBe(0); // withdrawn q-2 no longer counts as open
  }, 30_000);

  it('the file-request gate: withdrawFileRequest is atomic/idempotent and blocks a provided card', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
         ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-file-it', 'File Repo', 'https://github.com/acme/file.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      [TEAM_ID],
    );
    const repoId = repoRow.id;
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'file gate') RETURNING id`,
      [TEAM_ID, repoId],
    );
    const jobId = thread.id;
    const mkFile = (id: string, path: string) => ({
      requestId: id,
      card: {
        type: 'file_request_card' as const,
        jobId,
        requestId: id,
        path,
        description: `Upload ${path}`,
      },
    });

    // open f-1 → card row persists (per-card, no counter) + surfaces as an open card (re-post guard).
    expect(await store.openFileRequest(jobId, mkFile('f-1', '.env.keys'))).toEqual({ ok: true });
    expect((await store.getFileCard(jobId, 'f-1'))?.path).toBe('.env.keys');
    expect((await store.openFileCards(jobId)).map((c) => c.requestId)).toEqual(['f-1']);

    // WITHDRAW f-1 → terminal; stamps withdrawnAt + reason; drops out of the open pipeline.
    expect(await store.withdrawFileRequest(jobId, 'f-1', 'wrong path')).toEqual({ withdrawn: true });
    expect((await store.getFileCard(jobId, 'f-1'))?.withdrawnAt).toBeTruthy();
    expect((await store.getFileCard(jobId, 'f-1'))?.withdrawnReason).toBe('wrong path');
    expect(await store.openFileCards(jobId)).toEqual([]); // withdrawn → no longer surfaced

    // Idempotent: a second withdraw is a no-op.
    expect(await store.withdrawFileRequest(jobId, 'f-1', 'again')).toEqual({ withdrawn: false });

    // A PROVIDED card cannot be withdrawn (the operator already uploaded → withdraw must not fire).
    expect(await store.openFileRequest(jobId, mkFile('f-2', 'infra/prod/.env.keys'))).toEqual({ ok: true });
    await store.markFileProvided(jobId, 'f-2', 'prod.env.keys');
    expect(await store.withdrawFileRequest(jobId, 'f-2', 'too late')).toEqual({ withdrawn: false });
    expect((await store.getFileCard(jobId, 'f-2'))?.withdrawnAt).toBeFalsy();
    expect(await store.openFileCards(jobId)).toEqual([]); // provided → also not surfaced as open

    // A withdrawn (unprovided) card is not a boot-redelivery candidate.
    expect(
      (await store.findUndeliveredProvidedFiles()).some((f) => f.requestId === 'f-1'),
    ).toBe(false);
  }, 30_000);

  it('hasRecentSystemOperatorNotice matches an identical recent notice, and only that (dedup guard)', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active') ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, $2, 'BrainStore Repo', 'https://github.com/acme/brainstore.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [TEAM_ID, PROJECT_SLUG],
    );
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'limit dedup') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const jobId = thread.id;
    const err = 'in-sandbox engine turn failed: monthly spend limit';

    // Nothing posted yet → no match.
    expect(await store.hasRecentSystemOperatorNotice(jobId, err)).toBe(false);

    await store.appendSystemOperatorMessage(jobId, err, { retryable: true });

    // Identical text within the window → matched (the guard suppresses the second box).
    expect(await store.hasRecentSystemOperatorNotice(jobId, err)).toBe(true);
    // A DIFFERENT error is never suppressed.
    expect(await store.hasRecentSystemOperatorNotice(jobId, `${err} (other)`)).toBe(false);
    // Outside the recency window (a `since` in the future) → not matched.
    expect(await store.hasRecentSystemOperatorNotice(jobId, err, -60_000)).toBe(false);
    // Scoped to the thread — another thread's identical notice doesn't match.
    expect(await store.hasRecentSystemOperatorNotice(TEAM_ID, err)).toBe(false);
  }, 30_000);

  it('recordSystemChunk persists a source-tagged row, is insert-once by chunkKey, and backdates before the message it rode with', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active') ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-chunk-it', 'Chunk Repo', 'https://github.com/acme/chunk.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [TEAM_ID],
    );
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'chunks') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const jobId = thread.id;
    const at = new Date(Date.UTC(2026, 5, 24, 0, 0, 5));

    // The operator's message lands at `at`; the reminder rode with it, backdated 2ms earlier.
    await insertUserMessage(dataSource, jobId, 'check the healthcheck', at);
    await store.recordSystemChunk({
      jobId,
      kind: 'system_reminder',
      text: 'open questions: q-1 (which region?)',
      chunkKey: 'brain:s1:system_reminder:0',
      reminderKind: 'open_questions',
      createdAt: new Date(at.getTime() - 2),
    });

    // The row is stored CLEAN (no XML tag), source-tagged so the classifier renders it distinctly.
    const rows: Array<{ text: string; kind: string; author_bot_id: string | null; meta: Record<string, unknown> }> =
      await dataSource.query(
        `SELECT text, kind, author_bot_id, meta FROM messages WHERE job_id = $1 AND meta->>'source' = 'system_reminder'`,
        [jobId],
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('open questions: q-1 (which region?)');
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].author_bot_id).toBeNull();
    expect(rows[0].meta.reminderKind).toBe('open_questions');

    // Backdated → sorts BEFORE the operator message it rode with (history orders by created_at ASC).
    expect(await messageTexts(dataSource, jobId)).toEqual([
      'open questions: q-1 (which region?)',
      'check the healthcheck',
    ]);

    // Insert-once: a re-drive of the SAME turn (same chunkKey) does not duplicate the row.
    await store.recordSystemChunk({
      jobId,
      kind: 'system_reminder',
      text: 'open questions: q-1 (which region?)',
      chunkKey: 'brain:s1:system_reminder:0',
      reminderKind: 'open_questions',
      createdAt: new Date(at.getTime() - 2),
    });
    const dupCount: Array<{ n: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS n FROM messages WHERE job_id = $1 AND meta->>'source' = 'system_reminder'`,
      [jobId],
    );
    expect(Number(dupCount[0].n)).toBe(1);
  }, 30_000);

  it('withdrawPlan on an awaiting job atomically flips it back to planning and supersedes the draft record', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-withdraw-it');
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'withdraw me', kind: 'feature' });
    const { decisionRecordId } = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'withdraw me',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      threadTitles: ['backend'],
    });
    expect(await jobStatus(dataSource, jobId)).toBe('awaiting_approval');

    expect(await store.withdrawPlan(jobId, 'pivoting')).toEqual({ withdrawn: true });

    expect(await jobStatus(dataSource, jobId)).toBe('planning');
    expect(await recordStatus(dataSource, decisionRecordId)).toBe('superseded');
  }, 30_000);

  it('withdrawPlan on a job that is NOT awaiting approval is a no-op ({withdrawn:false}), status unchanged', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-withdraw2-it');
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'not awaiting', kind: 'feature' });
    expect(await jobStatus(dataSource, jobId)).toBe('planning'); // openJob leaves it in planning, not awaiting

    expect(await store.withdrawPlan(jobId, 'nothing to withdraw')).toEqual({ withdrawn: false });

    expect(await jobStatus(dataSource, jobId)).toBe('planning'); // unchanged
  }, 30_000);

  it('RACE: withdrawPlan wins over a stale approve — approve(jobId, recId, approvedBy) returns null once withdrawn', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-race-it');
    const approverId = await seedApprover(dataSource);
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'race', kind: 'feature' });
    const { decisionRecordId } = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'race',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      threadTitles: ['backend'],
    });

    expect(await store.withdrawPlan(jobId, 'pivoting')).toEqual({ withdrawn: true });

    // The operator's approve click races in AFTER the withdraw — the guard (status='awaiting_approval')
    // already failed, so it must approve NOTHING.
    expect(await store.approve(jobId, decisionRecordId, approverId, 'plan')).toBeNull();
    expect(await jobStatus(dataSource, jobId)).toBe('planning');
    expect(await recordStatus(dataSource, decisionRecordId)).toBe('superseded');
  }, 30_000);

  it('HAPPY PATH: approve(jobId, recId, approvedBy) atomically flips the job to running and stamps the record approved', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-happy-it');
    const approverId = await seedApprover(dataSource);
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'happy path', kind: 'feature' });
    const { decisionRecordId } = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'happy path',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      threadTitles: ['backend'],
    });

    const running = await store.approve(jobId, decisionRecordId, approverId, 'plan');

    expect(running?.status).toBe('running');
    expect(await recordStatus(dataSource, decisionRecordId)).toBe('approved');
    expect(await buildPath(dataSource, jobId)).toBe('plan');
  }, 30_000);

  it('VERSION PIN: a stale approve on the superseded R1 record fails the guard; approve on the current R2 record succeeds (the exact stale-card scenario)', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-versionpin-it');
    const approverId = await seedApprover(dataSource);
    await store.openJob({ orgId: TEAM_ID, repoId, jobId, title: 'version pin v1', kind: 'feature' });
    const r1 = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'version pin v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      threadTitles: ['backend'],
    });
    // Re-propose — R2 supersedes R1 (still one job row, decision_record_id now points at R2).
    const r2 = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'version pin v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      threadTitles: ['backend v2'],
    });
    expect(r2.decisionRecordId).not.toBe(r1.decisionRecordId);

    // A stale click on the R1 card: the job is still awaiting_approval, but decision_record_id now points
    // at R2, so the guard on R1 fails → null, and nothing about the job changes.
    expect(await store.approve(jobId, r1.decisionRecordId, approverId, 'plan')).toBeNull();
    expect(await jobStatus(dataSource, jobId)).toBe('awaiting_approval'); // still pointing at R2
    expect(await recordStatus(dataSource, r1.decisionRecordId)).toBe('superseded');

    // The CURRENT card (R2) approves cleanly.
    const running = await store.approve(jobId, r2.decisionRecordId, approverId, 'plan');
    expect(running?.status).toBe('running');
    expect(await recordStatus(dataSource, r2.decisionRecordId)).toBe('approved');
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

/** The FEATURE (builder) thread briefs — excludes the appended master-review thread AND the render-only
 *  `main` row (both asserted / created separately). */
async function threadTitles(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM threads WHERE job_id = $1 AND kind = 'builder' ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.brief);
}

/** The count of appended master-review threads for a job (should be exactly 1 after a full plan). */
async function masterReviewCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::text AS n FROM threads WHERE job_id = $1 AND kind = 'master_review'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? '0');
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

/** FEATURE (builder) thread plans — excludes the master-review thread (plan null) and the `main` row. */
async function sectionPlans(ds: DataSource, jobId: string): Promise<Array<string | null>> {
  const rows: Array<{ plan: string | null }> = await ds.query(
    `SELECT plan FROM threads WHERE job_id = $1 AND kind = 'builder' ORDER BY ordinal ASC`,
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

/** The job row's current status (reuses `loadThreadRow`'s underlying query, narrowed to just the field). */
async function jobStatus(ds: DataSource, jobId: string): Promise<string | null> {
  return (await loadThreadRow(ds, jobId))?.status ?? null;
}

/** The committed build path stamped by `approve()` ('direct' | 'plan'), or null before any approval. */
async function buildPath(ds: DataSource, jobId: string): Promise<string | null> {
  const rows: Array<{ build_path: string | null }> = await ds.query(
    `SELECT build_path FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.build_path ?? null;
}

/** The sentinel approver's email — `decision_records.approved_by` FK's into `users`, so approve() tests
 *  need a real user row (a plain string like 'user' fails the uuid column outright). */
const APPROVER_EMAIL = 'brainstore-approver-it@test.local';

/** Seed (idempotently) the sentinel operator user that `approve()` tests stamp as the approver. */
async function seedApprover(ds: DataSource): Promise<string> {
  const [row]: Array<{ id: string }> = await ds.query(
    `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, 'x', 'BrainStore IT Approver', 'operator')
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    [APPROVER_EMAIL],
  );
  return row.id;
}

/** Seed an org (idempotent) + a repo (on a distinct slug) + a bare job row for the approval-path tests. */
async function seedJob(
  ds: DataSource,
  orgId: string,
  repoSlug: string,
): Promise<{ jobId: string; repoId: string }> {
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status)
       VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active')
       ON CONFLICT (id) DO NOTHING`,
    [orgId],
  );
  const [repoRow]: Array<{ id: string }> = await ds.query(
    `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
       VALUES ($1, $2, 'BrainStore Repo', 'https://github.com/acme/brainstore.git', 'main', true)
       ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    [orgId, repoSlug],
  );
  const repoId = repoRow.id;
  const [jobRow]: Array<{ id: string }> = await ds.query(
    `INSERT INTO jobs (org_id, repo_id, origin, title)
       VALUES ($1, $2, 'chat', $3) RETURNING id`,
    [orgId, repoId, repoSlug],
  );
  return { jobId: jobRow.id, repoId };
}

/** Delete every row this test's synthetic tenant owns (FK cascade from jobs/org does the rest). */
async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM jobs WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await ds.query(`DELETE FROM users WHERE email = $1`, [APPROVER_EMAIL]).catch(() => undefined);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
