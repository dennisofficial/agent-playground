/**
 * LIVE HTTP proof of the "per-job auto-approve" feature: boots the REAL `AppModule` over HTTP
 * (supertest, real cookie auth + `OrgMembershipGuard`), seeds `jobs` rows directly against live
 * Postgres, then drives `PATCH /web/orgs/:orgId/repos/:repoId/jobs/:jobId/auto-approve` and asserts
 * the endpoint's full contract:
 *
 *   - ENABLE with no gate parked (status='open'): 200 `{ok:true,autoApprove:true}`; the row flips
 *     `auto_approve=true` + `auto_approve_by=<caller>`; `GET .../pipeline` round-trips `autoApprove:true`
 *     on the `no_job` shape.
 *   - ENABLE while `awaiting_ship_review`: 200, AND — via the exact human-click seam
 *     (`WebSurface.receiveApprovalClick` → the web-surface-module bridge → `ThreadDriver.resolveShipApprovalDurably`)
 *     — the job auto-advances OUT of the gate with no separate click: `ship_review_approved_at` gets
 *     stamped and `status` flips `awaiting_ship_review → running`. THE key "auto-advances" proof.
 *   - DISABLE: 200 `{ok:true,autoApprove:false}`; `auto_approve=false`, `auto_approve_by` left set (audit).
 *   - Foreign-org job → 404. Non-boolean `enabled` → 400.
 *
 * Mirrors `web-surface.shipping.int.test.ts` / `web-surface.spin-up-preview.int.test.ts` for HTTP/auth
 * setup and the ship-gate row shape.
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { CredentialResolver } from '../onboarding/credential-resolver.service';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG = '88888888-8888-4888-8888-888888888801';
const REPO = '88888888-8888-4888-8888-888888888802';
const OPEN_JOB = '88888888-8888-4888-8888-888888888803'; // enable, no gate parked
const SHIP_GATE_JOB = '88888888-8888-4888-8888-888888888804'; // enable while awaiting_ship_review
const DISABLE_JOB = '88888888-8888-4888-8888-888888888805'; // enable then disable
const FOREIGN_ORG = '88888888-8888-4888-8888-888888888806';
const FOREIGN_REPO = '88888888-8888-4888-8888-888888888807';
const FOREIGN_JOB = '88888888-8888-4888-8888-888888888808'; // lives in a different org
const BAD_BODY_JOB = '88888888-8888-4888-8888-888888888809';

const OWNER_EMAIL = 'auto-approve-it-owner@example.test';
const PASSWORD = 'auto-approve-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
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
  await ds.query(`DELETE FROM jobs WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]]).catch(() => undefined);
  await ds.query(`DELETE FROM repos WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]]).catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds.query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG, FOREIGN_ORG]]).catch(() => undefined);
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
    `SELECT status, auto_approve, auto_approve_by, ship_review_approved_at FROM jobs WHERE id = $1`,
    [jobId],
  )) as Array<Record<string, unknown>>;
  return rows[0];
}

/** Poll the DB until `predicate` is true or the timeout elapses — the ship-gate resolve is
 *  fire-and-forget through the module bridge (`approval$` subscriber), so it lands shortly AFTER
 *  the HTTP response, not synchronously with it. */
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
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;
  ownerId = owner.id;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Auto Approve Org', 'auto-approve-org', 'active')`,
    [ORG],
  );
  await ds.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    ORG,
    owner.id,
  ]);
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'auto-approve-repo', 'Auto Approve Repo', 'https://github.com/atlas-it/auto-approve.git', 'main', true)`,
    [REPO, ORG],
  );

  // A SECOND org/repo/job the owner is NOT a member of — proves the endpoint 404s across tenants.
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

  // CASE 1 — enable, no gate parked: a plain planning job.
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Open planning job', 'open')`,
    [OPEN_JOB, ORG, REPO],
  );

  // CASE 2 — enable while parked at the ship-review gate (mirrors web-surface.spin-up-preview.int.test.ts's
  // seedGateJob: kind='feature', status='awaiting_ship_review', activity='idle', ship marker still null).
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity, ship_review_approved_at)
     VALUES ($1, $2, $3, 'control', 'Ready to ship build', 'feature', 'awaiting_ship_review', 'idle', NULL)`,
    [SHIP_GATE_JOB, ORG, REPO],
  );

  // CASE 3 — enable then disable: a plain running job (no gate to auto-resolve, keeps the disable
  // assertion isolated from the ship-gate re-drive).
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Disable target job', 'running')`,
    [DISABLE_JOB, ORG, REPO],
  );

  // CASE 4b — bad body target (status irrelevant, just needs to exist in-org).
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Bad body job', 'open')`,
    [BAD_BODY_JOB, ORG, REPO],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('auto-approve — PATCH .../jobs/:jobId/auto-approve (live Postgres, real HTTP)', () => {
  it('CASE 1 — enable with no gate parked: 200, DB row flips auto_approve + auto_approve_by; pipeline round-trips autoApprove', async () => {
    const res = await request(server)
      .patch(autoApproveUrl(OPEN_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApprove: true });

    const row = await loadJobRow(OPEN_JOB);
    expect(row).toMatchObject({ auto_approve: true, auto_approve_by: ownerId });
    // eslint-disable-next-line no-console -- evidence: OBSERVED DB row after enable.
    console.log('OBSERVED CASE 1 DB row (open job, enabled):', JSON.stringify(row));

    // Sub-case 5: pipeline DTO for a still-`open` job rides the `no_job` shape and must surface autoApprove.
    const pipe = await request(server).get(pipelineUrl(OPEN_JOB)).set('Cookie', ownerCookie);
    expect(pipe.status).toBe(200);
    expect(pipe.body).toMatchObject({ status: 'no_job', autoApprove: true });
    // eslint-disable-next-line no-console
    console.log('OBSERVED CASE 1 GET pipeline:', JSON.stringify(pipe.body));
  });

  it('CASE 2 — enable while awaiting_ship_review: 200, then the job auto-advances OUT of the gate with no separate click', async () => {
    const before = await loadJobRow(SHIP_GATE_JOB);
    expect(before).toMatchObject({ status: 'awaiting_ship_review', ship_review_approved_at: null });
    // eslint-disable-next-line no-console
    console.log('OBSERVED CASE 2 DB row BEFORE PATCH:', JSON.stringify(before));

    const res = await request(server)
      .patch(autoApproveUrl(SHIP_GATE_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoApprove: true });

    // The resolve is fire-and-forget through the `approval$` → web-surface-module bridge →
    // `ThreadDriver.resolveShipApprovalDurably` → `DriverStoreService.approveShip` (a conditional UPDATE
    // that flips `awaiting_ship_review → running` + stamps `ship_review_approved_at`), so poll briefly.
    await waitFor(async () => {
      const row = await loadJobRow(SHIP_GATE_JOB);
      return row?.status !== 'awaiting_ship_review';
    });

    const after = await loadJobRow(SHIP_GATE_JOB);
    // THE key "auto-advances with no click" proof: the gate resolved on its own.
    expect(after).toMatchObject({ status: 'running', auto_approve: true, auto_approve_by: ownerId });
    expect(after?.ship_review_approved_at).not.toBeNull();
    // eslint-disable-next-line no-console
    console.log(
      `OBSERVED CASE 2 transition: awaiting_ship_review -> ${String(after?.status)} (ship_review_approved_at=${String(after?.ship_review_approved_at)})`,
    );
    // eslint-disable-next-line no-console
    console.log('OBSERVED CASE 2 DB row AFTER auto-advance:', JSON.stringify(after));
  });

  it('CASE 3 — disable: 200, auto_approve=false but auto_approve_by stays set (audit)', async () => {
    const enableRes = await request(server)
      .patch(autoApproveUrl(DISABLE_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: true });
    expect(enableRes.status).toBe(200);
    const afterEnable = await loadJobRow(DISABLE_JOB);
    expect(afterEnable).toMatchObject({ auto_approve: true, auto_approve_by: ownerId });

    const disableRes = await request(server)
      .patch(autoApproveUrl(DISABLE_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: false });

    expect(disableRes.status).toBe(200);
    expect(disableRes.body).toEqual({ ok: true, autoApprove: false });

    const afterDisable = await loadJobRow(DISABLE_JOB);
    expect(afterDisable).toMatchObject({ auto_approve: false, auto_approve_by: ownerId });
    // eslint-disable-next-line no-console
    console.log('OBSERVED CASE 3 DB row after enable then disable:', JSON.stringify(afterDisable));
  });

  it('CASE 4a — foreign-org job: 404 (caller IS a member of the URL org, but the jobId belongs to a different org)', async () => {
    // Use the CALLER's OWN org/repo in the URL (so `OrgMembershipGuard` passes — 403 would mean the
    // guard rejected before reaching the controller) but target a jobId that actually lives in
    // FOREIGN_ORG. `requireThread`'s org-scoped lookup (`{ id: jobId, org_id: org.id }`) must 404.
    const res = await request(server)
      .patch(autoApproveUrl(FOREIGN_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: true });
    expect(res.status).toBe(404);

    const row = await loadJobRow(FOREIGN_JOB);
    expect(row).toMatchObject({ auto_approve: false });
  });

  it('CASE 4b — non-boolean `enabled`: 400', async () => {
    const res = await request(server)
      .patch(autoApproveUrl(BAD_BODY_JOB))
      .set('Cookie', ownerCookie)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);

    const missing = await request(server)
      .patch(autoApproveUrl(BAD_BODY_JOB))
      .set('Cookie', ownerCookie)
      .send({});
    expect(missing.status).toBe(400);
  });
});
