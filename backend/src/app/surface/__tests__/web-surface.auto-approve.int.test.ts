
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { CLASSIFIER_LLM } from '../../decision-gate';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { JobBootstrapService } from '../../job-bootstrap';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ChatStimulusBridge } from '../../stimulus/chat-stimulus.bridge';
import { JobTitler } from '../../titling';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

const ORG = '88888888-8888-4888-8888-888888888801';
const REPO = '88888888-8888-4888-8888-888888888802';
const OPEN_JOB = '88888888-8888-4888-8888-888888888803'; // set mode, no gate parked
const SHIP_GATE_JOB = '88888888-8888-4888-8888-888888888804'; // mode='ship' while awaiting_ship_review
const SHIP_GATE_NO_RESOLVE_JOB = '88888888-8888-4888-8888-888888888805'; // mode='plan' while awaiting_ship_review
const SHIP_GATE_BOTH_JOB = '88888888-8888-4888-8888-888888888806'; // mode='both' while awaiting_ship_review
const PLAN_GATE_JOB = '88888888-8888-4888-8888-888888888807'; // mode='plan' while awaiting_approval
const PLAN_GATE_NO_RESOLVE_JOB = '88888888-8888-4888-8888-888888888808'; // mode='ship' while awaiting_approval
const PLAN_GATE_BOTH_JOB = '88888888-8888-4888-8888-888888888809'; // mode='both' while awaiting_approval
const PLAN_GATE_DR = '88888888-8888-4888-8888-88888888880a';
const PLAN_GATE_NO_RESOLVE_DR = '88888888-8888-4888-8888-88888888880b';
const PLAN_GATE_BOTH_DR = '88888888-8888-4888-8888-88888888880c';
const DISABLE_JOB = '88888888-8888-4888-8888-88888888880d'; // set then mode='off'
const FOREIGN_ORG = '88888888-8888-4888-8888-88888888880e';
const FOREIGN_REPO = '88888888-8888-4888-8888-88888888880f';
const FOREIGN_JOB = '88888888-8888-4888-8888-888888888810'; // lives in a different org
const BAD_BODY_JOB = '88888888-8888-4888-8888-888888888811';

const PLAN_GATE_DRS = [PLAN_GATE_DR, PLAN_GATE_NO_RESOLVE_DR, PLAN_GATE_BOTH_DR];

const OWNER_EMAIL = 'auto-approve-it-owner@example.test';
const PASSWORD = 'auto-approve-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let bootstrap: JobBootstrapService;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let ownerId: string;

async function register(email: string): Promise<{ cookie: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: email.split('@')[0] });
  expect(res.status).toBe(200);
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, id: res.body.user.id as string };
}

async function purge(): Promise<void> {
  await ds
    .query(`DELETE FROM decision_records WHERE id = ANY($1)`, [PLAN_GATE_DRS])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM jobs WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM repos WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds.query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL]).catch(() => undefined);
}

function autoApproveUrl(jobId: string, orgId = ORG, repoId = REPO): string {
  return `/web/orgs/${orgId}/repos/${repoId}/jobs/${jobId}/auto-approve`;
}

function pipelineUrl(jobId: string): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}/pipeline`;
}

async function loadJobRow(jobId: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await ds.query(
    `SELECT status, activity, build_path, auto_approve_mode, auto_approve_by, ship_review_approved_at
       FROM jobs WHERE id = $1`,
    [jobId],
  )) as Array<Record<string, unknown>>;
  return rows[0];
}

async function seedAwaitingApproval(jobId: string, drId: string, title: string): Promise<void> {
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity, base_branch)
     VALUES ($1, $2, $3, 'control', $4, 'feature', 'awaiting_approval', 'idle', 'main')`,
    [jobId, ORG, REPO, title],
  );
  await bootstrap.ensurePlanningThreadGroup(jobId, ORG);
  await ds.query(
    `INSERT INTO decision_records (id, org_id, repo_id, job_id, overview, status, thread_titles)
     VALUES ($1, $2, $3, $4, 'Add token-bucket rate limiting to the API.', 'draft', $5)`,
    [drId, ORG, REPO, jobId, ['Backend']],
  );
  await ds.query(`UPDATE jobs SET decision_record_id = $1 WHERE id = $2`, [drId, jobId]);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 100 } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  const prevSurface = process.env.SURFACE;
  process.env.SURFACE = 'agent';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLASSIFIER_LLM)
    .useValue(new FakeClassifierLlm())
    .overrideProvider(ENGINE_RUNNER)
    .useValue(new FakeEngineRunner())
    .overrideProvider(LocalGitService)
    .useValue(new FakeLocalGitService())
    .overrideProvider(GithubPrService)
    .useValue({})
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .overrideProvider(JobTitler)
    .useValue(new FakeThreadTitler())
    .overrideProvider(ChatStimulusBridge)
    .useValue({})
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  bootstrap = app.get(JobBootstrapService);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;
  ownerId = owner.id;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Auto Approve Org', 'auto-approve-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'auto-approve-repo', 'Auto Approve Repo', 'https://github.com/atlas-it/auto-approve.git', 'main', true)`,
    [REPO, ORG],
  );

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Foreign Org', 'auto-approve-foreign-org', 'active')`,
    [FOREIGN_ORG],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'auto-approve-foreign-repo', 'Foreign Repo', 'https://github.com/atlas-it/auto-approve-foreign.git', 'main', true)`,
    [FOREIGN_REPO, FOREIGN_ORG],
  );
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Foreign build', 'open')`,
    [FOREIGN_JOB, FOREIGN_ORG, FOREIGN_REPO],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Open planning job', 'open')`,
    [OPEN_JOB, ORG, REPO],
  );

  for (const [id, title] of [
    [SHIP_GATE_JOB, 'Ready to ship build'],
    [SHIP_GATE_NO_RESOLVE_JOB, 'Ready to ship build (no-resolve)'],
    [SHIP_GATE_BOTH_JOB, 'Ready to ship build (both)'],
  ] as const) {
    await ds.query(
      `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity, ship_review_approved_at)
       VALUES ($1, $2, $3, 'control', $4, 'feature', 'awaiting_ship_review', 'idle', NULL)`,
      [id, ORG, REPO, title],
    );
  }

  await seedAwaitingApproval(PLAN_GATE_JOB, PLAN_GATE_DR, 'Plan gate resolves');
  await seedAwaitingApproval(
    PLAN_GATE_NO_RESOLVE_JOB,
    PLAN_GATE_NO_RESOLVE_DR,
    'Plan gate no-resolve',
  );
  await seedAwaitingApproval(PLAN_GATE_BOTH_JOB, PLAN_GATE_BOTH_DR, 'Plan gate resolves (both)');

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Disable target job', 'running')`,
    [DISABLE_JOB, ORG, REPO],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Bad body job', 'open')`,
    [BAD_BODY_JOB, ORG, REPO],
  );
  await Promise.all([
    bootstrap.ensurePlanningThreadGroup(FOREIGN_JOB, FOREIGN_ORG),
    bootstrap.ensurePlanningThreadGroup(OPEN_JOB, ORG),
    bootstrap.ensurePlanningThreadGroup(SHIP_GATE_JOB, ORG),
    bootstrap.ensurePlanningThreadGroup(SHIP_GATE_NO_RESOLVE_JOB, ORG),
    bootstrap.ensurePlanningThreadGroup(SHIP_GATE_BOTH_JOB, ORG),
    bootstrap.ensurePlanningThreadGroup(DISABLE_JOB, ORG),
    bootstrap.ensurePlanningThreadGroup(BAD_BODY_JOB, ORG),
  ]);

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('auto-approve — PATCH .../jobs/:jobId/auto-approve (live Postgres, real HTTP)', () => {
  it("CASE 1 — mode='both' with no gate parked: 200, DB row flips auto_approve_mode + auto_approve_by; pipeline round-trips autoApproveMode", async () => {
    const res = await request(server)
      .patch(autoApproveUrl(OPEN_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'both' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'both' });

    const row = await loadJobRow(OPEN_JOB);
    expect(row).toMatchObject({
      auto_approve_mode: 'both',
      auto_approve_by: ownerId,
    });
    console.log('OBSERVED CASE 1 DB row (open job, mode=both):', JSON.stringify(row));

    const pipe = await request(server).get(pipelineUrl(OPEN_JOB)).set('Cookie', ownerCookie);
    expect(pipe.status).toBe(200);
    expect(pipe.body).toMatchObject({
      status: 'no_job',
      autoApproveMode: 'both',
    });
    console.log('OBSERVED CASE 1 GET pipeline:', JSON.stringify(pipe.body));
  });

  it("CASE 2a — mode='ship' while awaiting_ship_review: 200, then the job auto-advances OUT of the gate, and the (now non-no_job) pipeline shape still carries autoApproveMode", async () => {
    const before = await loadJobRow(SHIP_GATE_JOB);
    expect(before).toMatchObject({
      status: 'awaiting_ship_review',
      ship_review_approved_at: null,
    });

    const res = await request(server)
      .patch(autoApproveUrl(SHIP_GATE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'ship' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'ship' });

    await waitFor(async () => {
      const row = await loadJobRow(SHIP_GATE_JOB);
      return row?.status !== 'awaiting_ship_review';
    });

    const after = await loadJobRow(SHIP_GATE_JOB);
    expect(after).toMatchObject({
      status: 'running',
      auto_approve_mode: 'ship',
      auto_approve_by: ownerId,
    });
    expect(after?.ship_review_approved_at).not.toBeNull();
    console.log(
      `OBSERVED CASE 2a transition: awaiting_ship_review -> ${String(after?.status)} (ship_review_approved_at=${String(after?.ship_review_approved_at)})`,
    );

    const pipe = await request(server).get(pipelineUrl(SHIP_GATE_JOB)).set('Cookie', ownerCookie);
    expect(pipe.status).toBe(200);
    expect(pipe.body).not.toMatchObject({ status: 'no_job' });
    expect(pipe.body).toMatchObject({ autoApproveMode: 'ship' });
    console.log('OBSERVED CASE 2a GET pipeline (normal shape):', JSON.stringify(pipe.body));
  });

  it("CASE 2b — mode='plan' while awaiting_ship_review: does NOT resolve the ship gate", async () => {
    const res = await request(server)
      .patch(autoApproveUrl(SHIP_GATE_NO_RESOLVE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'plan' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'plan' });

    await settle();
    const after = await loadJobRow(SHIP_GATE_NO_RESOLVE_JOB);
    expect(after).toMatchObject({
      status: 'awaiting_ship_review',
      ship_review_approved_at: null,
    });
  });

  it("CASE 2c — mode='both' while awaiting_ship_review: resolves the ship gate", async () => {
    const res = await request(server)
      .patch(autoApproveUrl(SHIP_GATE_BOTH_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'both' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'both' });

    await waitFor(async () => {
      const row = await loadJobRow(SHIP_GATE_BOTH_JOB);
      return row?.status !== 'awaiting_ship_review';
    });

    const after = await loadJobRow(SHIP_GATE_BOTH_JOB);
    expect(after).toMatchObject({ status: 'running' });
    expect(after?.ship_review_approved_at).not.toBeNull();
  });

  it("CASE 3a — mode='plan' while awaiting_approval: resolves the plan gate (job advances to running/base_check)", async () => {
    const before = await loadJobRow(PLAN_GATE_JOB);
    expect(before).toMatchObject({ status: 'awaiting_approval' });

    const res = await request(server)
      .patch(autoApproveUrl(PLAN_GATE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'plan' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'plan' });

    await waitFor(async () => {
      const row = await loadJobRow(PLAN_GATE_JOB);
      return (
        row?.status === 'running' && row.activity === 'base_check' && row.build_path === 'plan'
      );
    });

    const after = await loadJobRow(PLAN_GATE_JOB);
    expect(after).toMatchObject({
      status: 'running',
      activity: 'base_check',
      build_path: 'plan',
    });
    console.log('OBSERVED CASE 3a DB row after auto-resolve:', JSON.stringify(after));
  });

  it("CASE 3b — mode='ship' while awaiting_approval: does NOT resolve the plan gate", async () => {
    const res = await request(server)
      .patch(autoApproveUrl(PLAN_GATE_NO_RESOLVE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'ship' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'ship' });

    await settle();
    const after = await loadJobRow(PLAN_GATE_NO_RESOLVE_JOB);
    expect(after).toMatchObject({ status: 'awaiting_approval' });
  });

  it("CASE 3c — mode='both' while awaiting_approval: resolves the plan gate", async () => {
    const res = await request(server)
      .patch(autoApproveUrl(PLAN_GATE_BOTH_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'both' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApproveMode: 'both' });

    await waitFor(async () => {
      const row = await loadJobRow(PLAN_GATE_BOTH_JOB);
      return row?.status === 'running' && row.activity === 'base_check';
    });

    const after = await loadJobRow(PLAN_GATE_BOTH_JOB);
    expect(after).toMatchObject({ status: 'running', activity: 'base_check' });
  });

  it("CASE 4 — mode='off': 200, auto_approve_mode='off' with NO auto_approve_by write (the prior stamp is left untouched, audit)", async () => {
    const enableRes = await request(server)
      .patch(autoApproveUrl(DISABLE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'both' });
    expect(enableRes.status).toBe(200);
    const afterEnable = await loadJobRow(DISABLE_JOB);
    expect(afterEnable).toMatchObject({
      auto_approve_mode: 'both',
      auto_approve_by: ownerId,
    });

    const disableRes = await request(server)
      .patch(autoApproveUrl(DISABLE_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'off' });

    expect(disableRes.status).toBe(200);
    expect(disableRes.body).toEqual({ ok: true, autoApproveMode: 'off' });

    const afterDisable = await loadJobRow(DISABLE_JOB);
    expect(afterDisable).toMatchObject({
      auto_approve_mode: 'off',
      auto_approve_by: ownerId,
    });
    console.log(
      'OBSERVED CASE 4 DB row after set(both) then set(off):',
      JSON.stringify(afterDisable),
    );
  });

  it('CASE 5a — foreign-org job: 404 (caller IS a member of the URL org, but the jobId belongs to a different org)', async () => {
    const res = await request(server)
      .patch(autoApproveUrl(FOREIGN_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'both' });
    expect(res.status).toBe(404);

    const row = await loadJobRow(FOREIGN_JOB);
    expect(row).toMatchObject({ auto_approve_mode: 'off' });
  });

  it('CASE 5b — invalid / missing `mode`: 400', async () => {
    const res = await request(server)
      .patch(autoApproveUrl(BAD_BODY_JOB))
      .set('Cookie', ownerCookie)
      .send({ mode: 'yes' });
    expect(res.status).toBe(400);

    const missing = await request(server)
      .patch(autoApproveUrl(BAD_BODY_JOB))
      .set('Cookie', ownerCookie)
      .send({});
    expect(missing.status).toBe(400);
  });
});

describe('auto-approve — POST .../jobs armed at creation (live Postgres, real HTTP)', () => {
  const createUrl = `/web/orgs/${ORG}/repos/${REPO}/jobs`;

  async function createJob(body: Record<string, unknown>): Promise<string> {
    const res = await request(server).post(createUrl).set('Cookie', ownerCookie).send(body);
    expect(res.status).toBe(201);
    expect(typeof res.body.jobId).toBe('string');
    return res.body.jobId as string;
  }

  it("CREATE 1 — autoApproveMode='plan' at creation: the new job row is stamped auto_approve_mode='plan' + auto_approve_by=<caller>", async () => {
    const jobId = await createJob({
      firstMessage: 'Add a health endpoint.',
      autoApproveMode: 'plan',
    });
    const row = await loadJobRow(jobId);
    expect(row).toMatchObject({
      auto_approve_mode: 'plan',
      auto_approve_by: ownerId,
    });
    console.log('OBSERVED CREATE 1 DB row (created with mode=plan):', JSON.stringify(row));
  });

  it("CREATE 2 — no autoApproveMode: the new job falls back to the org default (unset here, so 'off') with no auto_approve_by", async () => {
    const jobId = await createJob({
      firstMessage: 'Plain job, no auto-approve.',
    });
    const row = await loadJobRow(jobId);
    expect(row).toMatchObject({
      auto_approve_mode: 'off',
      auto_approve_by: null,
    });
    console.log('OBSERVED CREATE 2 DB row (created with no mode):', JSON.stringify(row));
  });

  it("CREATE 3 — autoApproveMode='off' explicitly: same as omitting it (off, no auto_approve_by)", async () => {
    const jobId = await createJob({
      firstMessage: 'Explicit off.',
      autoApproveMode: 'off',
    });
    const row = await loadJobRow(jobId);
    expect(row).toMatchObject({
      auto_approve_mode: 'off',
      auto_approve_by: null,
    });
  });

  it('CREATE 4 — a present-but-invalid autoApproveMode is REJECTED (400), never silently falling back to the org default', async () => {
    const res = await request(server)
      .post(createUrl)
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'Bogus mode.', autoApproveMode: 'bogus' });
    expect(res.status).toBe(400);
  });
});
