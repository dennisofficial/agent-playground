import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import { agentMessage } from '@shared/prompt-kit/message';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppOldModule } from '../../app-v1.module';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import { DriverStoreService } from '../../driver/driver-store.service';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeGithubPrService,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobTitler } from '../../titling/job-titler.service';
import { BrainStoreService } from '../brain-store.service';

const TEAM_ID = '33333333-3333-4333-8333-333333333333'; // sentinel org uuid
const PROJECT_SLUG = 'brainstore-it';

describe('BrainStoreService re-propose (live Postgres)', () => {
  let app: NestExpressApplication;
  let store: BrainStoreService;
  let driverStore: DriverStoreService;
  let dataSource: DataSource;

  const prevSurface = process.env.SURFACE;

  beforeAll(async () => {
    process.env.SURFACE = 'agent';

    const moduleRef = await Test.createTestingModule({ imports: [AppOldModule] })
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

    store = app.get(BrainStoreService);
    driverStore = app.get(DriverStoreService);
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'rate limiting',
      kind: 'feature',
    });

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
    expect(await masterReviewCount(dataSource, jobId)).toBe(1);

    await store.reopenPlanning(jobId);

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

    expect(await threadTitles(dataSource, jobId)).toEqual(['backend middleware only']);

    expect(await recordStatus(dataSource, first.decisionRecordId)).toBe('superseded');
    expect(await recordStatus(dataSource, second.decisionRecordId)).toBe('draft');
    expect(await draftCount(dataSource, jobId)).toBe(1);
  }, 30_000);

  it('PLAN VERSIONING: a re-propose over a DONE builder preserves the prior revision as history and forges a new one', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'versioning-repo');

    const first = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      threadTitles: ['backend one'],
    });
    await dataSource.query(
      `UPDATE threads t
          SET status = 'done'
         FROM thread_groups s
        WHERE s.id = t.thread_group_id
          AND s.decision_record_id = $1
          AND t.role = 'builder'`,
      [first.decisionRecordId],
    );

    await dataSource.query(`UPDATE jobs SET status = 'amending' WHERE id = $1`, [jobId]);

    const second = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'v2',
      kind: 'feature',
      overview: 'overview v2',
      decisions: [],
      threadTitles: ['backend two'],
    });
    expect(second.decisionRecordId).not.toBe(first.decisionRecordId);

    expect(await builderBriefsForRecord(dataSource, first.decisionRecordId)).toEqual([
      'backend one',
    ]);
    expect(await builderBriefsForRecord(dataSource, second.decisionRecordId)).toEqual([
      'backend two',
    ]);
    expect(await mainCount(dataSource, jobId)).toBe(1);

    const state = (await driverStore.getPipelineState(jobId, TEAM_ID)) as {
      threadGroups: Array<{ threads: Array<{ brief: string; role: string }> }>;
      priorRevisions: Array<{
        revision: number;
        threadGroups: Array<{
          threads: Array<{ brief: string; role: string }>;
        }>;
      }>;
    };
    const builders = (threadGroups: Array<{ threads: Array<{ brief: string; role: string }> }>) =>
      threadGroups
        .flatMap((s) => s.threads)
        .filter((t) => t.role === 'builder')
        .map((t) => t.brief);
    expect(builders(state.threadGroups)).toEqual(['backend two']);
    expect(state.priorRevisions).toHaveLength(1);
    expect(state.priorRevisions[0].revision).toBe(1);
    expect(builders(state.priorRevisions[0].threadGroups)).toEqual(['backend one']);
  }, 30_000);

  it('PLAN VERSIONING: a DIRECT build (empty threadTitles) over done work preserves history and creates no builders', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'versioning-direct-repo');

    const first = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'v1',
      kind: 'feature',
      overview: 'overview v1',
      decisions: [],
      threadTitles: ['backend one'],
    });
    await dataSource.query(
      `UPDATE threads t
          SET status = 'done'
         FROM thread_groups s
        WHERE s.id = t.thread_group_id
          AND s.decision_record_id = $1
          AND t.role = 'builder'`,
      [first.decisionRecordId],
    );
    await dataSource.query(`UPDATE jobs SET status = 'amending' WHERE id = $1`, [jobId]);

    const second = await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'v2 direct',
      kind: 'feature',
      overview: 'fold-in',
      decisions: [],
      threadTitles: [],
    });
    expect(await builderBriefsForRecord(dataSource, first.decisionRecordId)).toEqual([
      'backend one',
    ]);
    expect(await builderBriefsForRecord(dataSource, second.decisionRecordId)).toEqual([]);
    expect(await masterReviewCount(dataSource, jobId)).toBe(1); // only v1's master review remains

    const state = (await driverStore.getPipelineState(jobId, TEAM_ID)) as {
      threadGroups: Array<{ threads: Array<{ brief: string; role: string }> }>;
      priorRevisions: Array<{
        threadGroups: Array<{
          threads: Array<{ brief: string; role: string }>;
        }>;
      }>;
    };
    expect(
      state.threadGroups.flatMap((s) => s.threads.filter((t) => t.role === 'builder')),
    ).toEqual([]);
    expect(state.priorRevisions).toHaveLength(1);
    expect(
      state.priorRevisions[0].threadGroups
        .flatMap((s) => s.threads)
        .filter((t) => t.role === 'builder')
        .map((t) => t.brief),
    ).toEqual(['backend one']);
  }, 30_000);

  it('openJob anchors the thread into planning without clobbering an existing title when no title is given', async () => {
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);

    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: '',
      kind: 'feature',
    });
    let row = await loadThreadRow(dataSource, jobId);
    expect(row?.status).toBe('planning');
    expect(row?.title).toBe('Discuss next feature');

    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: '   ',
      kind: 'feature',
    });
    row = await loadThreadRow(dataSource, jobId);
    expect(row?.title).toBe('Discuss next feature');

    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'Profile picture CRUD',
      kind: 'feature',
    });
    row = await loadThreadRow(dataSource, jobId);
    expect(row?.title).toBe('Profile picture CRUD');
  }, 30_000);

  it('persistPlan coerces off-vocabulary thread types at the write boundary', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-thread-types-it');
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'types',
      kind: 'feature',
    });

    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'typed plan',
      kind: 'feature',
      overview: 'overview',
      decisions: [],
      threadTitles: ['legacy analytics', 'case backend', 'missing'],
      threadTypes: ['analytics', 'BACKEND'],
    });

    expect(await threadTypes(dataSource, jobId)).toEqual(['general', 'backend', 'general']);
  }, 30_000);

  it('stamps appended blocks with their emission time so a mid-turn user message keeps chronological order', async () => {
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    const at = (sec: number) => new Date(Date.UTC(2026, 5, 24, 0, 0, sec));

    await insertUserMessage(dataSource, jobId, 'first question', at(0));
    await store.appendBlock(jobId, {
      kind: 'chat',
      text: 'investigating',
      createdAt: at(1),
    });
    await store.appendBlock(jobId, {
      kind: 'chat',
      text: 'here is the answer',
      createdAt: at(2),
    });
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
    expect(row).toMatchObject({
      status: 'open',
      origin: 'control',
      title: 'follow-up',
      base_branch: 'main',
    });
    expect(row?.created_by_job_id).toBeNull();
    expect(row?.created_by).toBeNull();

    const grandchildId = await store.createFollowUpJob({
      orgId: TEAM_ID,
      repoId,
      title: 'grandchild',
      baseBranch: 'main',
      createdByJobId: followUpId,
      createdByTitle: 'parent',
    });
    const grandchildRow = await loadThreadRow(dataSource, grandchildId);
    expect(grandchildRow?.created_by_job_id).toBe(followUpId);
    expect(grandchildRow?.created_by).toEqual({
      jobId: followUpId,
      title: 'parent',
    });
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);

    await store.appendCardMessage(jobId, {
      ts: 'q-1',
      text: 'Editable or fixed?',
      card: {
        type: 'question_card',
        jobId,
        questionId: 'q-1',
        question: 'Editable or fixed?',
        options: [],
      },
    });
    await store.updateCardMessage(jobId, 'q-1', {
      answer: 'Editable',
      answeredAt: '2026-06-26T00:00:00Z',
    });
    const answered = await store.latestAnsweredQuestionCard(jobId);
    expect((answered?.card as { answer?: string } | null)?.answer).toBe('Editable');

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

    const updated = await store.updateDecision(jobId, 'd1', {
      ruling: 'fixed (final)',
    });
    expect(updated?.decision).toMatchObject({
      id: 'd1',
      ruling: 'fixed (final)',
    });
    expect(await store.updateDecision(jobId, 'd9', { ruling: 'x' })).toBeNull(); // unknown id

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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'authored',
      kind: 'feature',
    });

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

    const plans1 = await sectionPlans(dataSource, jobId);
    expect(plans1.every((p) => p != null && p.length > 0)).toBe(true);
    expect(plans1[0]).toContain('add the entity at server.entity.ts:1');
    expect(plans1[0]).toContain('add the service at server.service.ts:1');
    expect(plans1[1]).toContain('add the page at page.tsx:1');

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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    const mkCard = (id: string, q: string) => ({
      ts: id,
      text: q,
      card: {
        type: 'question_card',
        jobId,
        questionId: id,
        question: q,
        options: [],
      },
    });

    expect(await store.openQuestion(jobId, mkCard('q-1', 'Editable or fixed?'))).toEqual({
      ok: true,
    });
    expect(await openCount(dataSource, jobId)).toBe(1);
    expect((await store.getQuestionCard(jobId, 'q-1'))?.question).toBe('Editable or fixed?');

    expect(await store.openQuestion(jobId, mkCard('q-2', 'Which region?'))).toEqual({ ok: true });
    expect(await openCount(dataSource, jobId)).toBe(2);
    expect((await store.getQuestionCard(jobId, 'q-2'))?.question).toBe('Which region?');

    expect(await store.markQuestionAnswered(jobId, 'q-1', 'Editable')).toEqual({
      firstAnswer: true,
    });
    expect(await store.markQuestionAnswered(jobId, 'q-1', 'Editable-again')).toEqual({
      firstAnswer: false,
    });
    expect(await openCount(dataSource, jobId)).toBe(1); // only the winning answer decremented
    expect((await store.getQuestionCard(jobId, 'q-1'))?.answer).toBe('Editable'); // not overwritten

    expect(await store.findUndeliveredAnsweredQuestions()).toContainEqual(
      expect.objectContaining({
        jobId,
        orgId: TEAM_ID,
        repoId,
        questionId: 'q-1',
        answer: 'Editable',
      }),
    );

    await store.markQuestionDelivered(jobId, 'q-1');
    expect((await store.getQuestionCard(jobId, 'q-1'))?.deliveredAt).toBeTruthy();
    expect((await store.findUndeliveredAnsweredQuestions()).some((q) => q.jobId === jobId)).toBe(
      false,
    );

    await dataSource.query(`UPDATE jobs SET open_question_count = 99 WHERE id = $1`, [jobId]);
    await store.reconcileOpenQuestionCounts();
    expect(await openCount(dataSource, jobId)).toBe(1); // q-2 still unanswered

    const open1 = await store.openQuestionCards(jobId);
    expect(open1.map((c) => c.questionId)).toEqual(['q-2']);

    expect(await store.withdrawQuestion(jobId, 'q-2', 'reworded')).toEqual({
      withdrawn: true,
    });
    expect(await openCount(dataSource, jobId)).toBe(0);
    expect((await store.getQuestionCard(jobId, 'q-2'))?.withdrawnAt).toBeTruthy();
    expect((await store.getQuestionCard(jobId, 'q-2'))?.withdrawnReason).toBe('reworded');
    expect(await store.openQuestionCards(jobId)).toEqual([]);

    expect(await store.withdrawQuestion(jobId, 'q-2', 'again')).toEqual({
      withdrawn: false,
    });
    expect(await store.markQuestionAnswered(jobId, 'q-2', 'too late')).toEqual({
      firstAnswer: false,
    });
    expect(await openCount(dataSource, jobId)).toBe(0); // no double-decrement, no phantom answer

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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
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

    expect(await store.openFileRequest(jobId, mkFile('f-1', '.env.keys'))).toEqual({ ok: true });
    expect((await store.getFileCard(jobId, 'f-1'))?.path).toBe('.env.keys');
    expect((await store.openFileCards(jobId)).map((c) => c.requestId)).toEqual(['f-1']);

    expect(await store.withdrawFileRequest(jobId, 'f-1', 'wrong path')).toEqual({
      withdrawn: true,
    });
    expect((await store.getFileCard(jobId, 'f-1'))?.withdrawnAt).toBeTruthy();
    expect((await store.getFileCard(jobId, 'f-1'))?.withdrawnReason).toBe('wrong path');
    expect(await store.openFileCards(jobId)).toEqual([]); // withdrawn → no longer surfaced

    expect(await store.withdrawFileRequest(jobId, 'f-1', 'again')).toEqual({
      withdrawn: false,
    });

    expect(await store.openFileRequest(jobId, mkFile('f-2', 'infra/prod/.env.keys'))).toEqual({
      ok: true,
    });
    await store.markFileProvided(jobId, 'f-2', 'prod.env.keys');
    expect(await store.withdrawFileRequest(jobId, 'f-2', 'too late')).toEqual({
      withdrawn: false,
    });
    expect((await store.getFileCard(jobId, 'f-2'))?.withdrawnAt).toBeFalsy();
    expect(await store.openFileCards(jobId)).toEqual([]); // provided → also not surfaced as open

    expect((await store.findUndeliveredProvidedFiles()).some((f) => f.requestId === 'f-1')).toBe(
      false,
    );
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    const err = 'in-sandbox engine turn failed: monthly spend limit';

    expect(await store.hasRecentSystemOperatorNotice(jobId, err)).toBe(false);

    await store.appendSystemOperatorMessage(jobId, err, { retryable: true });

    expect(await store.hasRecentSystemOperatorNotice(jobId, err)).toBe(true);
    expect(await store.hasRecentSystemOperatorNotice(jobId, `${err} (other)`)).toBe(false);
    expect(await store.hasRecentSystemOperatorNotice(jobId, err, -60_000)).toBe(false);
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
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);
    const at = new Date(Date.UTC(2026, 5, 24, 0, 0, 5));

    await insertUserMessage(dataSource, jobId, 'check the healthcheck', at);
    await store.recordSystemChunk({
      jobId,
      kind: 'system_reminder',
      text: agentMessage('open questions: q-1 (which region?)'),
      chunkKey: 'brain:s1:system_reminder:0',
      reminderKind: 'open_questions',
      createdAt: new Date(at.getTime() - 2),
    });

    const rows: Array<{
      text: string;
      kind: string;
      author_bot_id: string | null;
      meta: Record<string, unknown>;
    }> = await dataSource.query(
      `SELECT text, kind, author_bot_id, meta FROM transcript_messages WHERE job_id = $1 AND meta->>'source' = 'system_reminder'`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('open questions: q-1 (which region?)');
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].author_bot_id).toBeNull();
    expect(rows[0].meta.reminderKind).toBe('open_questions');

    expect(await messageTexts(dataSource, jobId)).toEqual([
      'open questions: q-1 (which region?)',
      'check the healthcheck',
    ]);

    await store.recordSystemChunk({
      jobId,
      kind: 'system_reminder',
      text: agentMessage('open questions: q-1 (which region?)'),
      chunkKey: 'brain:s1:system_reminder:0',
      reminderKind: 'open_questions',
      createdAt: new Date(at.getTime() - 2),
    });
    const dupCount: Array<{ n: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS n FROM transcript_messages WHERE job_id = $1 AND meta->>'source' = 'system_reminder'`,
      [jobId],
    );
    expect(Number(dupCount[0].n)).toBe(1);
  }, 30_000);

  it('recordSystemChunk stashes the raw fullBody in meta when given, and omits it otherwise', async () => {
    await dataSource.query(
      `INSERT INTO organizations (id, name, slug, status)
         VALUES ($1, 'BrainStore Org', 'brainstore-it-org', 'active') ON CONFLICT (id) DO NOTHING`,
      [TEAM_ID],
    );
    const [repoRow]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, access_ok)
         VALUES ($1, 'brainstore-fullbody-it', 'FullBody Repo', 'https://github.com/acme/fullbody.git', 'main', true)
         ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [TEAM_ID],
    );
    const [thread]: Array<{ id: string }> = await dataSource.query(
      `INSERT INTO jobs (org_id, repo_id, origin, title)
         VALUES ($1, $2, 'chat', 'fullbody') RETURNING id`,
      [TEAM_ID, repoRow.id],
    );
    const jobId = thread.id;
    await ensurePlanningThread(dataSource, jobId, TEAM_ID);

    const rawPayload =
      '<system_notice>The MCP `Direct build` call failed: fields must be wrapped under `args`.</system_notice>';
    await store.recordSystemChunk({
      jobId,
      kind: 'system_notice',
      text: agentMessage('A harness system notification was delivered to Atlas.'),
      chunkKey: `seed:fullbody:${jobId}:with`,
      fullBody: agentMessage(rawPayload),
    });
    await store.recordSystemChunk({
      jobId,
      kind: 'system_notice',
      text: agentMessage('Opening the pull request.'),
      chunkKey: `seed:fullbody:${jobId}:without`,
    });

    const withRow: Array<{ meta: Record<string, unknown> }> = await dataSource.query(
      `SELECT meta FROM transcript_messages WHERE job_id = $1 AND meta->>'chunkKey' = $2`,
      [jobId, `seed:fullbody:${jobId}:with`],
    );
    const withoutRow: Array<{ meta: Record<string, unknown> }> = await dataSource.query(
      `SELECT meta FROM transcript_messages WHERE job_id = $1 AND meta->>'chunkKey' = $2`,
      [jobId, `seed:fullbody:${jobId}:without`],
    );
    expect(withRow[0].meta.fullBody).toBe(rawPayload);
    expect(withoutRow[0].meta.fullBody).toBeUndefined();
  }, 30_000);

  it('withdrawPlan on an awaiting job atomically flips it back to planning and supersedes the draft record', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-withdraw-it');
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'withdraw me',
      kind: 'feature',
    });
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

    expect(await store.withdrawPlan(jobId, 'pivoting')).toEqual({
      withdrawn: true,
    });

    expect(await jobStatus(dataSource, jobId)).toBe('planning');
    expect(await recordStatus(dataSource, decisionRecordId)).toBe('superseded');
  }, 30_000);

  it('withdrawPlan on a job that is NOT awaiting approval is a no-op ({withdrawn:false}), status unchanged', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-withdraw2-it');
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'not awaiting',
      kind: 'feature',
    });
    expect(await jobStatus(dataSource, jobId)).toBe('planning'); // openJob leaves it in planning, not awaiting

    expect(await store.withdrawPlan(jobId, 'nothing to withdraw')).toEqual({
      withdrawn: false,
    });

    expect(await jobStatus(dataSource, jobId)).toBe('planning'); // unchanged
  }, 30_000);

  it('openJobOnThread anchors an `amending` job too, not just `planning` — a ship-retract resumes as ONE build', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-amending-it');
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'amend me',
      kind: 'feature',
    });
    await dataSource.query(`UPDATE jobs SET status = 'amending' WHERE id = $1`, [jobId]);

    expect(await store.openJobOnThread(jobId)).toBe(jobId);
  }, 30_000);

  it('RACE: withdrawPlan wins over a stale approve — approve(jobId, recId, approvedBy) returns null once withdrawn', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-race-it');
    const approverId = await seedApprover(dataSource);
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'race',
      kind: 'feature',
    });
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

    expect(await store.withdrawPlan(jobId, 'pivoting')).toEqual({
      withdrawn: true,
    });

    expect(await store.approve(jobId, decisionRecordId, approverId, 'plan')).toBeNull();
    expect(await jobStatus(dataSource, jobId)).toBe('planning');
    expect(await recordStatus(dataSource, decisionRecordId)).toBe('superseded');
  }, 30_000);

  it('HAPPY PATH: approve(jobId, recId, approvedBy) atomically flips the job to running and stamps the record approved', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'brainstore-happy-it');
    const approverId = await seedApprover(dataSource);
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'happy path',
      kind: 'feature',
    });
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
    await store.openJob({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'version pin v1',
      kind: 'feature',
    });
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

    expect(await store.approve(jobId, r1.decisionRecordId, approverId, 'plan')).toBeNull();
    expect(await jobStatus(dataSource, jobId)).toBe('awaiting_approval'); // still pointing at R2
    expect(await recordStatus(dataSource, r1.decisionRecordId)).toBe('superseded');

    const running = await store.approve(jobId, r2.decisionRecordId, approverId, 'plan');
    expect(running?.status).toBe('running');
    expect(await recordStatus(dataSource, r2.decisionRecordId)).toBe('approved');
  }, 30_000);

  it('appendSystemNotice persists a calm System-authored operator row (meta.source=system_notice, bot_id null)', async () => {
    const { jobId } = await seedJob(dataSource, TEAM_ID, 'brainstore-sysnotice-it');

    await store.appendSystemNotice(jobId, 'Plan approved — dispatching the build.');

    const row = await loadMessageRow(dataSource, jobId);
    expect(row).toMatchObject({
      author: 'System',
      author_id: 'system',
      author_bot_id: null, // the marker that the web renders this as a SYSTEM notice, not an Atlas turn
      text: 'Plan approved — dispatching the build.',
    });
    expect(row?.meta?.source).toBe('system_notice');
    expect(row?.meta?.halted).toBeUndefined(); // no error/Resume semantics (contrast appendSystemOperatorMessage)
  }, 30_000);

  it('recordSystemChunk on an untrusted wake row stores meta.framing separately, without leaking the engine body into fullBody', async () => {
    const { jobId } = await seedJob(dataSource, TEAM_ID, 'brainstore-framing-it');

    await store.recordSystemChunk({
      jobId,
      kind: 'untrusted',
      text: agentMessage('summary: build parked at ship gate'),
      chunkKey: `seed:done:framing-it`,
      untrustedSource: 'thread-done:th-x',
      severity: 'final',
      framing: 'An AUTONOMOUS wake — you may NOT ship without the operator.',
    });

    const row = await loadMessageRow(dataSource, jobId);
    expect(row?.meta?.source).toBe('untrusted');
    expect(row?.meta?.untrustedSource).toBe('thread-done:th-x');
    expect(row?.meta?.framing).toBe('An AUTONOMOUS wake — you may NOT ship without the operator.');
    expect(row?.meta?.fullBody).toBeUndefined(); // the trusted framing rides in meta.framing, not the amber pill
    expect(row?.text).toBe('summary: build parked at ship gate'); // amber fence = clean lane self-report only
  }, 30_000);

  it('RENAME GATE: rename:false keeps the current title; true/omitted re-titles; a null-title job is always titled', async () => {
    const { jobId, repoId } = await seedJob(dataSource, TEAM_ID, 'rename-gate');
    expect(await jobTitleOf(dataSource, jobId)).toBe('rename-gate');

    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'a brand new different goal',
      kind: 'feature',
      overview: 'ov',
      decisions: [],
      threadTitles: ['backend'],
      rename: false,
    });
    expect(await jobTitleOf(dataSource, jobId)).toBe('rename-gate');

    await store.reopenPlanning(jobId);
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'omitted-rename goal',
      kind: 'feature',
      overview: 'ov',
      decisions: [],
      threadTitles: ['backend'],
    });
    expect(await jobTitleOf(dataSource, jobId)).toBe('omitted-rename goal');

    await store.reopenPlanning(jobId);
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'explicit-rename goal',
      kind: 'feature',
      overview: 'ov',
      decisions: [],
      threadTitles: ['backend'],
      rename: true,
    });
    expect(await jobTitleOf(dataSource, jobId)).toBe('explicit-rename goal');

    await store.reopenPlanning(jobId);
    await dataSource.query(`UPDATE jobs SET title = NULL WHERE id = $1`, [jobId]);
    await store.persistPlan({
      orgId: TEAM_ID,
      repoId,
      jobId,
      title: 'fallback title for a nameless job',
      kind: 'feature',
      overview: 'ov',
      decisions: [],
      threadTitles: ['backend'],
      rename: false,
    });
    expect(await jobTitleOf(dataSource, jobId)).toBe('fallback title for a nameless job');
  }, 30_000);
});

async function jobTitleOf(ds: DataSource, jobId: string): Promise<string | null> {
  const rows: Array<{ title: string | null }> = await ds.query(
    `SELECT title FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.title ?? null;
}

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
  const threadId = await ensurePlanningThread(ds, jobId, TEAM_ID);
  await ds.query(
    `INSERT INTO transcript_messages (job_id, thread_id, author, author_id, text, kind, created_at, updated_at)
       VALUES ($1, $2, 'Operator', 'op', $3, 'chat', $4, $4)`,
    [jobId, threadId, text, createdAt.toISOString()],
  );
}

async function loadMessageRow(
  ds: DataSource,
  jobId: string,
): Promise<{
  author: string;
  author_id: string;
  author_bot_id: string | null;
  text: string;
  meta: Record<string, unknown> | null;
} | null> {
  const rows: Array<{
    author: string;
    author_id: string;
    author_bot_id: string | null;
    text: string;
    meta: Record<string, unknown> | null;
  }> = await ds.query(
    `SELECT author, author_id, author_bot_id, text, meta FROM transcript_messages
       WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

async function messageTexts(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ text: string }> = await ds.query(
    `SELECT text FROM transcript_messages WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return rows.map((r) => r.text);
}

async function threadTitles(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT brief FROM threads WHERE job_id = $1 AND role = 'builder' ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.brief);
}

async function threadTypes(ds: DataSource, jobId: string): Promise<string[]> {
  const rows: Array<{ type: string }> = await ds.query(
    `SELECT type FROM threads WHERE job_id = $1 AND role = 'builder' ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.type);
}

async function masterReviewCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::text AS n FROM threads WHERE job_id = $1 AND role = 'master_review'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? '0');
}

async function builderBriefsForRecord(ds: DataSource, recordId: string): Promise<string[]> {
  const rows: Array<{ brief: string }> = await ds.query(
    `SELECT t.brief
       FROM threads t
       JOIN thread_groups s ON s.id = t.thread_group_id
      WHERE s.decision_record_id = $1 AND t.role = 'builder'
      ORDER BY t.ordinal ASC`,
    [recordId],
  );
  return rows.map((r) => r.brief);
}

async function mainCount(ds: DataSource, jobId: string): Promise<number> {
  const rows: Array<{ n: string }> = await ds.query(
    `SELECT COUNT(*)::text AS n FROM threads WHERE job_id = $1 AND role = 'planning'`,
    [jobId],
  );
  return Number(rows[0]?.n ?? '0');
}

async function sectionPlans(ds: DataSource, jobId: string): Promise<Array<string | null>> {
  const rows: Array<{ plan: string | null }> = await ds.query(
    `SELECT plan FROM threads WHERE job_id = $1 AND role = 'builder' ORDER BY ordinal ASC`,
    [jobId],
  );
  return rows.map((r) => r.plan);
}

async function loadThreadRow(
  ds: DataSource,
  jobId: string,
): Promise<{
  status: string;
  origin: string;
  title: string | null;
  base_branch: string | null;
  created_by_job_id: string | null;
  created_by: { jobId: string; title: string | null } | null;
} | null> {
  const rows: Array<{
    status: string;
    origin: string;
    title: string | null;
    base_branch: string | null;
    created_by_job_id: string | null;
    created_by: { jobId: string; title: string | null } | null;
  }> = await ds.query(
    `SELECT status, origin, title, base_branch, created_by_job_id, created_by FROM jobs WHERE id = $1`,
    [jobId],
  );
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

async function jobStatus(ds: DataSource, jobId: string): Promise<string | null> {
  return (await loadThreadRow(ds, jobId))?.status ?? null;
}

async function buildPath(ds: DataSource, jobId: string): Promise<string | null> {
  const rows: Array<{ build_path: string | null }> = await ds.query(
    `SELECT build_path FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.build_path ?? null;
}

const APPROVER_EMAIL = 'brainstore-approver-it@test.local';

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
  await ensurePlanningThread(ds, jobRow.id, orgId);
  return { jobId: jobRow.id, repoId };
}

async function ensurePlanningThread(ds: DataSource, jobId: string, orgId: string): Promise<string> {
  const existing: Array<{ thread_group_id: string; thread_id: string | null }> = await ds.query(
    `SELECT s.id AS thread_group_id, t.id AS thread_id
         FROM thread_groups s
         LEFT JOIN threads t ON t.thread_group_id = s.id AND t.role = 'planning'
        WHERE s.job_id = $1 AND s.kind = 'planning'
        ORDER BY s.ordinal ASC
        LIMIT 1`,
    [jobId],
  );
  let threadGroupId = existing[0]?.thread_group_id;
  if (!threadGroupId) {
    const [threadGroup]: Array<{ id: string }> = await ds.query(
      `INSERT INTO thread_groups (job_id, org_id, ordinal, kind, title)
         VALUES ($1, $2, 10, 'planning', 'Planning')
         RETURNING id`,
      [jobId, orgId],
    );
    threadGroupId = threadGroup.id;
  }
  if (existing[0]?.thread_id) return existing[0].thread_id;
  const [thread]: Array<{ id: string }> = await ds.query(
    `INSERT INTO threads (thread_group_id, job_id, org_id, role, ordinal, brief, type, status)
       VALUES ($1, $2, $3, 'planning', 0, 'Main', 'general', 'pending')
       RETURNING id`,
    [threadGroupId, jobId, orgId],
  );
  return thread.id;
}

async function purge(ds: DataSource): Promise<void> {
  const q = (sql: string) => ds.query(sql, [TEAM_ID]).catch(() => undefined);
  await q(`DELETE FROM jobs WHERE org_id = $1`);
  await q(`DELETE FROM repos WHERE org_id = $1`);
  await ds.query(`DELETE FROM users WHERE email = $1`, [APPROVER_EMAIL]).catch(() => undefined);
  await q(`DELETE FROM organizations WHERE id = $1`);
}
