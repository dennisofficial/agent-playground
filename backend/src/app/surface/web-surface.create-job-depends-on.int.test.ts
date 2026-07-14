/**
 * LIVE HTTP proof of "born-blocked create" (spec: sections/01-backend.md): `POST
 * /web/orgs/:orgId/repos/:repoId/jobs` accepts an additive `dependsOn` job-id list and, when at least
 * one requested blocker is still LIVE, creates the job BORN BLOCKED — mirroring the `create_job`
 * host-tool path — instead of injecting its first message. Boots the REAL `AppModule` over HTTP
 * (supertest, real cookie auth + `OrgMembershipGuard`), against live Postgres.
 *
 * `WebSurface.inbound$` is observed directly (not mocked) to prove `receiveFromClient` fired or didn't
 * — the cleanest, real signal that the immediate-start path did/didn't run. `BrainGateway` is replaced
 * with a capture double (mirrors `job-deps/job-dependency.int.test.ts`) so the already-proven wake
 * funnel (`onBlockerResolved` → `wakeUnblockedJob`) can be driven directly against a seed created via
 * this HTTP endpoint, without booting a real sandbox/git remote (out of scope for this thread — no
 * wake-side code changed).
 *
 * Covers 01-backend.md's Validation scenarios:
 *  - invalid / cross-repo `dependsOn` id → reject before any row is created;
 *  - a live blocker → job created `status='blocked'`, `blocked_seed_message` set, no sandbox/branch,
 *    NO `receiveFromClient` (no `inbound$` emission);
 *  - an already-terminal blocker (or no `dependsOn`) → unchanged immediate-start behavior;
 *  - multiple blockers → stays blocked until every one resolves;
 *  - resolving the last blocker replays the exact HTTP-assembled seed through the existing wake funnel.
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { BrainGateway } from '../brain-gateway';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { JobDependencyService } from '../job-deps';
import { WebSurface } from './web-surface';
import type { InboundChatMessage } from './chat-surface.port';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG = '99999999-9999-4999-8999-999999999901';
const REPO = '99999999-9999-4999-8999-999999999902';
const FOREIGN_ORG = '99999999-9999-4999-8999-999999999903';
const FOREIGN_REPO = '99999999-9999-4999-8999-999999999904';
const FOREIGN_JOB = '99999999-9999-4999-8999-999999999905';

const OWNER_EMAIL = 'create-job-depends-on-it-owner@example.test';
const PASSWORD = 'depends-on-it-pw-12345';

interface WakeCall {
  jobId: string;
  orgId: string;
  repoId: string;
  seed: string | null;
  note: string | null;
}

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let surface: WebSurface;
let jobDeps: JobDependencyService;
let ownerCookie: string;
let wakes: WakeCall[];

async function register(
  email: string,
): Promise<{ cookie: string; id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: email.split('@')[0] });
  expect(res.status).toBe(200);
  const setCookie =
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { cookie, id: res.body.user.id as string };
}

async function purge(): Promise<void> {
  await ds
    .query(`DELETE FROM job_dependencies WHERE org_id = ANY($1)`, [
      [ORG, FOREIGN_ORG],
    ])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM jobs WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM repos WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = ANY($1)`, [
      [ORG, FOREIGN_ORG],
    ])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organizations WHERE id = ANY($1)`, [[ORG, FOREIGN_ORG]])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL])
    .catch(() => undefined);
}

function jobsUrl(): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs`;
}

async function loadJobRow(
  jobId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows: Array<Record<string, unknown>> = await ds.query(
    `SELECT status, activity, blocked_seed_message, feature_branch FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0];
}

async function blockersOf(jobId: string): Promise<string[]> {
  const rows: Array<{ id: string }> = await ds.query(
    `SELECT depends_on_job_id AS id FROM job_dependencies WHERE job_id = $1`,
    [jobId],
  );
  return rows.map((r) => r.id);
}

async function countJobs(): Promise<number> {
  const rows: Array<{ n: number }> = await ds.query(
    `SELECT count(*)::int AS n FROM jobs WHERE org_id = $1`,
    [ORG],
  );
  return rows[0].n;
}

/** Collect every `inbound$` emission during `fn`, keyed by threadTs — proves whether `receiveFromClient`
 *  fired for a given job without mocking the surface (so the real code path runs end-to-end). */
async function captureInbound<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; emitted: InboundChatMessage[] }> {
  const emitted: InboundChatMessage[] = [];
  const sub = surface.inbound$.subscribe((m) => emitted.push(m));
  try {
    const result = await fn();
    return { result, emitted };
  } finally {
    sub.unsubscribe();
  }
}

beforeAll(async () => {
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
    // Capture double (mirrors job-dependency.int.test.ts) so we can drive the already-proven wake
    // funnel directly against a seed created via THIS endpoint, without a real sandbox/git remote.
    .overrideProvider(BrainGateway)
    .useValue({
      bind: () => undefined,
      openPrAtShip: async () => undefined,
      notifyThreadHalted: async () => undefined,
      notifyThreadDone: async () => undefined,
      wakeForProvisioningFailure: async () => undefined,
      wakeUnblockedJob: async (
        jobId: string,
        orgId: string,
        repoId: string,
        input: { seed: string | null; note: string | null },
      ) => {
        wakes.push({
          jobId,
          orgId,
          repoId,
          seed: input.seed,
          note: input.note,
        });
      },
    })
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  surface = app.get(WebSurface);
  jobDeps = app.get(JobDependencyService);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Depends On Org', 'depends-on-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'depends-on-repo', 'Depends On Repo', 'https://github.com/atlas-it/depends-on.git', 'main', true)`,
    [REPO, ORG],
  );

  // A foreign org/repo/job the owner is NOT a member of — proves cross-repo dependsOn ids 404.
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Foreign Org', 'depends-on-foreign-org', 'active')`,
    [FOREIGN_ORG],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'depends-on-foreign-repo', 'Foreign Repo', 'https://github.com/atlas-it/depends-on-foreign.git', 'main', true)`,
    [FOREIGN_REPO, FOREIGN_ORG],
  );
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Foreign build', 'open')`,
    [FOREIGN_JOB, FOREIGN_ORG, FOREIGN_REPO],
  );
});

afterAll(async () => {
  await purge();
  await app?.close();
});

beforeEach(() => {
  wakes = [];
});

describe('POST .../jobs — dependsOn (born-blocked create)', () => {
  it('rejects an unknown (but well-formed) dependsOn id with 404 and creates no row', async () => {
    const before = await countJobs();
    const res = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({
        firstMessage: 'depends on a ghost',
        dependsOn: '99999999-9999-4999-8999-000000000000',
      });
    expect(res.status).toBe(404);
    expect(await countJobs()).toBe(before); // no orphan row left behind
  });

  it('rejects a dependsOn id from a foreign repo with 404 and creates no row', async () => {
    const before = await countJobs();
    const res = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({
        firstMessage: 'depends on a foreign job',
        dependsOn: [FOREIGN_JOB],
      });
    expect(res.status).toBe(404);
    expect(await countJobs()).toBe(before);
  });

  it('with no dependsOn, starts immediately (unchanged behavior — regression)', async () => {
    const { result: res, emitted } = await captureInbound(() =>
      request(server)
        .post(jobsUrl())
        .set('Cookie', ownerCookie)
        .send({ firstMessage: 'plain job, no deps' }),
    );
    expect(res.status).toBe(201);
    const jobId = res.body.jobId as string;

    expect(emitted.some((m) => m.threadTs === jobId)).toBe(true); // receiveFromClient fired
    const row = await loadJobRow(jobId);
    expect(row?.status).toBe('open');
    expect(row?.blocked_seed_message).toBeNull();
  });

  it('with a LIVE blocker, is created born-blocked — no receiveFromClient, no branch, seed stored', async () => {
    const blockerRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'the blocker job' });
    expect(blockerRes.status).toBe(201);
    const blockerId = blockerRes.body.jobId as string;
    // Confirm the blocker itself is live (default fresh row: status 'open', pr_state null).
    expect((await loadJobRow(blockerId))?.status).toBe('open');

    const { result: res, emitted } = await captureInbound(() =>
      request(server)
        .post(jobsUrl())
        .set('Cookie', ownerCookie)
        .send({ firstMessage: 'blocked follow-up', dependsOn: [blockerId] }),
    );
    expect(res.status).toBe(201);
    const jobId = res.body.jobId as string;

    expect(emitted.some((m) => m.threadTs === jobId)).toBe(false); // NOT injected — born-blocked instead
    const row = await loadJobRow(jobId);
    expect(row?.status).toBe('blocked');
    expect(row?.blocked_seed_message).toBe('blocked follow-up'); // the full assembled bodyText
    expect(row?.feature_branch).toBeNull(); // no sandbox/branch provisioned while blocked
    expect(await blockersOf(jobId)).toEqual([blockerId]);
  });

  it('with only an already-TERMINAL blocker, starts immediately (not blocked)', async () => {
    const terminalRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'a job whose PR already merged' });
    const terminalId = terminalRes.body.jobId as string;
    await ds.query(
      `UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`,
      [terminalId],
    );

    const { result: res, emitted } = await captureInbound(() =>
      request(server)
        .post(jobsUrl())
        .set('Cookie', ownerCookie)
        .send({
          firstMessage: 'depends on an already-merged job',
          dependsOn: [terminalId],
        }),
    );
    expect(res.status).toBe(201);
    const jobId = res.body.jobId as string;

    expect(emitted.some((m) => m.threadTs === jobId)).toBe(true); // started — the "blocker" is already dead
    const row = await loadJobRow(jobId);
    expect(row?.status).toBe('open');
    expect(row?.blocked_seed_message).toBeNull();
  });

  it('with MULTIPLE live blockers, stays blocked until the LAST one resolves (replays the exact HTTP seed)', async () => {
    const aRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'blocker A' });
    const bRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'blocker B' });
    const a = aRes.body.jobId as string;
    const b = bRes.body.jobId as string;

    const { result: res, emitted } = await captureInbound(() =>
      request(server)
        .post(jobsUrl())
        .set('Cookie', ownerCookie)
        .send({ firstMessage: 'multi-blocked follow-up', dependsOn: [a, b] }),
    );
    expect(res.status).toBe(201);
    const dependent = res.body.jobId as string;
    expect(emitted.some((m) => m.threadTs === dependent)).toBe(false);
    expect((await loadJobRow(dependent))?.status).toBe('blocked');
    expect(await blockersOf(dependent)).toEqual(expect.arrayContaining([a, b]));

    // Resolve the first blocker — still parked on the second.
    await ds.query(
      `UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`,
      [a],
    );
    await jobDeps.onBlockerResolved(a, 'merged');
    expect((await loadJobRow(dependent))?.status).toBe('blocked');
    expect(wakes).toHaveLength(0);

    // Resolve the last blocker — the existing (unmodified) wake funnel fires, replaying the exact
    // bodyText this endpoint assembled and stored as blocked_seed_message.
    await ds.query(
      `UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`,
      [b],
    );
    await jobDeps.onBlockerResolved(b, 'merged');

    const row = await loadJobRow(dependent);
    expect(row?.status).toBe('open');
    expect(row?.blocked_seed_message).toBeNull(); // dropped once the wake dispatched
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      jobId: dependent,
      seed: 'multi-blocked follow-up',
      note: null,
    });
  });
});
