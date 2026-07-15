/**
 * LIVE HTTP proof that the recovery-mechanics escape hatches (45671fd5) actually round-trip through the
 * REAL data path over the wire: boots the REAL `AppModule` (supertest, real cookie auth via
 * `POST /auth/register` + the global `AuthGuard` + `OrgMembershipGuard`), seeds a `threads` row directly
 * against live Postgres with a `judge_unavailable` (or other) `terminal_record`, then invokes the two new
 * POST endpoints exactly as the web console does:
 *
 *   - `POST /web/orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/retry-verification`
 *     → `dispatcher.operatorRetryStuckThread`
 *   - `POST /web/orgs/:orgId/repos/:repoId/jobs/:jobId/threads/:threadId/accept`
 *     → `dispatcher.operatorAcceptStuckThread`
 *
 * Covers both DETERMINISTIC refusal paths (server-side gating that never depends on the async drive), one
 * happy-path accept (asserts only the synchronous HTTP response — the background `void this.drive(...)`
 * kicked by a true accept is fire-and-forget and would race a DB assertion), a real-auth-enforced 401 with
 * no cookie, and an org-scoping 404 via `requireThread`.
 *
 * Modeled EXACTLY on `web-surface.halt.int.test.ts`'s AppModule-boot + supertest + real-cookie harness;
 * the `terminal_record` shape mirrors `driver/recovery-mechanics.int.test.ts`'s `judgeUnavailableRecord`.
 */

import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFIER_LLM } from '../decision-gate';
import { ENGINE_RUNNER } from '../engine';
import { GithubPrService, LocalGitService } from '../git';
import { AppModule } from '../app.module';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';
import type { ThreadTerminalRecord } from '../persistence/entities/thread.entity';
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

// Fixed ids → distinct prefix from every other int/e2e test (each purges by its own ids).
const ORG = '79999999-7999-4799-8799-799999999901';
const REPO = '79999999-7999-4799-8799-799999999902';
// Job/thread pair for: accept refused because the STATIC checks never passed (d4 safety split).
const JOB_ACCEPT_REFUSE = '79999999-7999-4799-8799-799999999911';
const THREAD_ACCEPT_REFUSE = '79999999-7999-4799-8799-799999999912';
// Job/thread pair for: retry-verification refused because the hold is NOT a judge outage.
const JOB_RETRY_REFUSE = '79999999-7999-4799-8799-799999999921';
const THREAD_RETRY_REFUSE = '79999999-7999-4799-8799-799999999922';
// Job/thread pair for: accept happy path (judge_unavailable + static checks adequate).
const JOB_ACCEPT_OK = '79999999-7999-4799-8799-799999999931';
const THREAD_ACCEPT_OK = '79999999-7999-4799-8799-799999999932';
// A job id that plainly does not exist (any org) — proves org-scoping 404s via `requireThread`.
const JOB_NONEXISTENT = '79999999-7999-4799-8799-799999999999';
const THREAD_NONEXISTENT = '79999999-7999-4799-8799-799999999998';

const OWNER_EMAIL = 'recovery-http-e2e-owner@example.test';
const PASSWORD = 'recovery-http-e2e-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let threads: Repository<ThreadEntity>;

/** Mirrors `driver/recovery-mechanics.int.test.ts`'s `judgeUnavailableRecord` — the wedged prod row shape. */
function judgeUnavailableRecord(
  staticChecksAdequate: boolean,
): ThreadTerminalRecord {
  return {
    status: 'blocked',
    summary:
      'Backend recovery mechanics HTTP e2e — work complete, held on judge outage.',
    blocked: {
      reason: 'judge_unavailable',
      detail: 'the live-verification judge is temporarily unavailable',
    },
    staticVerification: {
      verdict: {
        staticChecksAdequate,
        reason: staticChecksAdequate
          ? 'typecheck + unit tests passed'
          : 'the static-check judge was itself unreachable',
      },
    },
  };
}

/** A hold that is NOT a judge outage — e.g. a genuine build/test failure. */
function nonJudgeBlockedRecord(): ThreadTerminalRecord {
  return {
    status: 'blocked',
    summary:
      'Backend recovery mechanics HTTP e2e — held on a real failure, not a judge outage.',
    blocked: {
      reason: 'unverified',
      detail: 'the build genuinely failed static verification',
    },
  };
}

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
    .query(`DELETE FROM threads WHERE org_id = $1`, [ORG])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM jobs WHERE org_id = $1`, [ORG])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM repos WHERE org_id = $1`, [ORG])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = $1`, [ORG])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM organizations WHERE id = $1`, [ORG])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL])
    .catch(() => undefined);
}

beforeAll(async () => {
  const prevSurface = process.env.SURFACE;
  const prevDisableResume = process.env.DISABLE_RESUME;
  process.env.SURFACE = 'agent';
  process.env.DISABLE_RESUME = '1';

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

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  threads = app.get<Repository<ThreadEntity>>(
    getRepositoryToken(ThreadEntity, DB_CONNECTION),
  );

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Recovery HTTP e2e Org', 'recovery-http-e2e-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'recovery-http-e2e-repo', 'Recovery HTTP e2e Repo', 'https://github.com/atlas-it/recovery-http-e2e.git', 'main', true)`,
    [REPO, ORG],
  );

  // Job + thread #1: judge_unavailable, static checks NOT adequate → accept must be REFUSED (d4).
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Recovery HTTP e2e — accept refuse', 'running')`,
    [JOB_ACCEPT_REFUSE, ORG, REPO],
  );
  const [threadGroupAcceptRefuse] = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
    [JOB_ACCEPT_REFUSE, ORG],
  );
  await threads.save(
    threads.create({
      id: THREAD_ACCEPT_REFUSE,
      thread_group_id: threadGroupAcceptRefuse.id,
      role: 'builder',
      job_id: JOB_ACCEPT_REFUSE,
      org_id: ORG,
      ordinal: 10,
      brief: 'Recovery HTTP e2e — static judge down, unverified',
      status: 'executing',
      condition: 'paused',
      terminal_record: judgeUnavailableRecord(false),
      halt_fix_attempts: 20,
    }),
  );

  // Job + thread #2: blocked, but NOT a judge outage → retry-verification must be REFUSED.
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Recovery HTTP e2e — retry refuse', 'running')`,
    [JOB_RETRY_REFUSE, ORG, REPO],
  );
  const [threadGroupRetryRefuse] = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
    [JOB_RETRY_REFUSE, ORG],
  );
  await threads.save(
    threads.create({
      id: THREAD_RETRY_REFUSE,
      thread_group_id: threadGroupRetryRefuse.id,
      role: 'builder',
      job_id: JOB_RETRY_REFUSE,
      org_id: ORG,
      ordinal: 10,
      brief: 'Recovery HTTP e2e — genuinely failed, not a judge outage',
      status: 'executing',
      condition: 'paused',
      terminal_record: nonJudgeBlockedRecord(),
      halt_fix_attempts: 3,
    }),
  );

  // Job + thread #3: judge_unavailable, static checks adequate → accept must SUCCEED (happy path).
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Recovery HTTP e2e — accept happy path', 'running')`,
    [JOB_ACCEPT_OK, ORG, REPO],
  );
  const [threadGroupAcceptOk] = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind) VALUES ($1, $2, 10, 'build') RETURNING id`,
    [JOB_ACCEPT_OK, ORG],
  );
  await threads.save(
    threads.create({
      id: THREAD_ACCEPT_OK,
      thread_group_id: threadGroupAcceptOk.id,
      role: 'builder',
      job_id: JOB_ACCEPT_OK,
      org_id: ORG,
      ordinal: 10,
      brief: 'Recovery HTTP e2e — live judge down, static passed',
      status: 'executing',
      condition: 'paused',
      terminal_record: judgeUnavailableRecord(true),
      halt_fix_attempts: 20,
    }),
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
  if (prevDisableResume === undefined) delete process.env.DISABLE_RESUME;
  else process.env.DISABLE_RESUME = prevDisableResume;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('Recovery mechanics — POST retry-verification / accept (live AppModule, real HTTP, real cookie auth)', () => {
  it('POST …/accept refuses over HTTP when static (build/test) checks have not passed (d4 safety split)', async () => {
    const res = await request(server)
      .post(
        `/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_ACCEPT_REFUSE}/threads/${THREAD_ACCEPT_REFUSE}/accept`,
      )
      .set('Cookie', ownerCookie)
      .send({});

    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live HTTP response verbatim.
    console.log(
      'OBSERVED POST .../accept [static-not-passed]:',
      res.status,
      JSON.stringify(res.body, null, 2),
    );

    expect([200, 201]).toContain(res.status);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.reason).toMatch(/static|build\/test/i);

    // The refusal is DETERMINISTIC and synchronous — the thread's terminal_record must be untouched (no
    // acceptRequested marker, no background drive kicked).
    const reloaded = await threads.findOne({
      where: { id: THREAD_ACCEPT_REFUSE },
    });
    expect(reloaded?.terminal_record?.acceptRequested).toBeUndefined();
  });

  it('POST …/retry-verification refuses over HTTP when the hold is not a judge outage', async () => {
    const res = await request(server)
      .post(
        `/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_RETRY_REFUSE}/threads/${THREAD_RETRY_REFUSE}/retry-verification`,
      )
      .set('Cookie', ownerCookie)
      .send({});

    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live HTTP response verbatim.
    console.log(
      'OBSERVED POST .../retry-verification [not-judge-outage]:',
      res.status,
      JSON.stringify(res.body, null, 2),
    );

    expect([200, 201]).toContain(res.status);
    expect(res.body).toMatchObject({ ok: false });
    expect(res.body.reason).toMatch(/verification-judge outage/i);

    // Deterministic + synchronous: the halt-fix-attempts budget must be untouched (no rearm happened).
    const reloaded = await threads.findOne({
      where: { id: THREAD_RETRY_REFUSE },
    });
    expect(reloaded?.halt_fix_attempts).toBe(3);
  });

  it('POST …/accept succeeds over HTTP for a genuine judge_unavailable hold with static checks adequate', async () => {
    const res = await request(server)
      .post(
        `/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_ACCEPT_OK}/threads/${THREAD_ACCEPT_OK}/accept`,
      )
      .set('Cookie', ownerCookie)
      .send({});

    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live HTTP response verbatim.
    console.log(
      'OBSERVED POST .../accept [happy path]:',
      res.status,
      JSON.stringify(res.body, null, 2),
    );

    expect([200, 201]).toContain(res.status);
    // Only the SYNCHRONOUS HTTP response is asserted — `operatorAcceptStuckThread` kicks the finalization
    // drive with `void this.drive(...)` (fire-and-forget), which would race any post-drive DB assertion.
    expect(res.body).toEqual({ ok: true });
  });

  it('POST …/retry-verification with NO auth cookie is rejected (real AuthGuard enforced, not bypassed)', async () => {
    const res = await request(server)
      .post(
        `/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_RETRY_REFUSE}/threads/${THREAD_RETRY_REFUSE}/retry-verification`,
      )
      .send({});

    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live HTTP response verbatim.
    console.log(
      'OBSERVED POST .../retry-verification [no cookie]:',
      res.status,
      JSON.stringify(res.body, null, 2),
    );

    expect([401, 403]).toContain(res.status);
  });

  it('POST …/accept 404s on a job that does not belong to (or exist in) the caller org (requireThread scoping)', async () => {
    const res = await request(server)
      .post(
        `/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_NONEXISTENT}/threads/${THREAD_NONEXISTENT}/accept`,
      )
      .set('Cookie', ownerCookie)
      .send({});

    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live HTTP response verbatim.
    console.log(
      'OBSERVED POST .../accept [org-scoping 404]:',
      res.status,
      JSON.stringify(res.body, null, 2),
    );

    expect(res.status).toBe(404);
  });
});
