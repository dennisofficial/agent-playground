/**
 * LIVE integration proof for THREAD 1 — the transcript renders in brain-processing order, not raw insert
 * (`created_at`) order. Reproduces the reported bug ("Plan approved" pill sorting above the reply of the
 * in-flight turn it was queued behind) and proves the fix end-to-end against REAL Postgres + a REAL HTTP
 * `GET …/messages` call.
 *
 * Two scenarios, mirroring the two mechanisms in the spec:
 *  (A) delivery-time ordering — a queued approval pill whose `delivered_at` (the true brain-consume
 *      instant, stamped by `markChatDelivered`) lands AFTER a reply that was mid-flight when the pill was
 *      enqueued. `created_at` alone would invert them (the reported bug); `COALESCE(order_at, delivered_at,
 *      created_at)` does not.
 *  (B) mid-turn pure-UI notice deferral — a notice posted while a turn streamed has no delivery instant,
 *      so `order_at` is the explicit escape hatch (what `TurnHarnessFactory.persistAll` stamps at turn end).
 *
 * Both assert the FULL contract: render POSITION moves, but the displayed `postedAt` (`created_at`) stays
 * the true, unchanged wall-clock time — only ordering is affected, never the timestamp shown to the
 * operator.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppOldModule } from '../app-v1.module';
import { CLASSIFIER_LLM } from '../decision-gate/classifier-llm';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { GithubPrService } from '../git/github-pr.service';
import { LocalGitService } from '../git/local-git.service';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobTitler } from '../titling/job-titler.service';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG = '77777777-7777-4777-8777-777777777801';
const REPO = '77777777-7777-4777-8777-777777777802';
const JOB_A = '77777777-7777-4777-8777-777777777803'; // scenario A: delivery-time ordering
const JOB_B = '77777777-7777-4777-8777-777777777804'; // scenario B: mid-turn notice deferral
const OWNER_EMAIL = 'messages-order-it-owner@example.test';
const PASSWORD = 'messages-order-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;

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
  await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG]).catch(() => undefined);
  await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG]).catch(() => undefined);
  await ds
    .query(`DELETE FROM organization_members WHERE org_id = $1`, [ORG])
    .catch(() => undefined);
  await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => undefined);
  await ds.query(`DELETE FROM users WHERE email = $1`, [OWNER_EMAIL]).catch(() => undefined);
}

/** Mirrors `brain-store.int.test.ts`'s `ensurePlanningThread` — every `transcript_messages` row needs a
 *  real `thread_id` (NOT NULL FK), so seed the job's planning thread group + thread directly. */
async function ensurePlanningThread(jobId: string): Promise<string> {
  const [threadGroup]: Array<{ id: string }> = await ds.query(
    `INSERT INTO thread_groups (job_id, org_id, ordinal, kind, title)
       VALUES ($1, $2, 10, 'planning', 'Planning')
       RETURNING id`,
    [jobId, ORG],
  );
  const [thread]: Array<{ id: string }> = await ds.query(
    `INSERT INTO threads (thread_group_id, job_id, org_id, role, ordinal, brief, type, status)
       VALUES ($1, $2, $3, 'planning', 0, 'Main', 'general', 'pending')
       RETURNING id`,
    [threadGroup.id, jobId, ORG],
  );
  return thread.id;
}

type Row = {
  id: string;
  thread_id: string;
  author: string;
  author_id: string;
  author_bot_id: string | null;
  text: string;
  kind: string;
  created_at: Date;
  delivered_at: Date | null;
  order_at: Date | null;
};

async function insertMessage(
  jobId: string,
  threadId: string,
  row: Omit<Row, 'id' | 'thread_id'>,
): Promise<string> {
  const [inserted]: Array<{ id: string }> = await ds.query(
    `INSERT INTO transcript_messages
       (job_id, thread_id, author, author_id, author_bot_id, text, kind, created_at, delivered_at, order_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
    [
      jobId,
      threadId,
      row.author,
      row.author_id,
      row.author_bot_id,
      row.text,
      row.kind,
      row.created_at,
      row.delivered_at,
      row.order_at,
    ],
  );
  return inserted.id;
}

beforeAll(async () => {
  const prevSurface = process.env.SURFACE;
  const prevDisableResume = process.env.DISABLE_RESUME;
  process.env.SURFACE = 'agent';
  process.env.DISABLE_RESUME = '1';

  const moduleRef = await Test.createTestingModule({ imports: [AppOldModule] })
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

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Messages Order Org', 'messages-order-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'messages-order-repo', 'Messages Order Repo', 'https://github.com/atlas-it/messages-order.git', 'main', true)`,
    [REPO, ORG],
  );
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Messages order A', 'running')`,
    [JOB_A, ORG, REPO],
  );
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Messages order B', 'running')`,
    [JOB_B, ORG, REPO],
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

describe('GET .../messages — brain-processing order, not raw insert order (live Postgres, real HTTP)', () => {
  it('(A) delivery-time ordering: a queued approval pill delivered AFTER an in-flight reply renders below it, timestamp unchanged', async () => {
    const threadId = await ensurePlanningThread(JOB_A);
    const t0 = new Date('2026-07-17T10:00:00.000Z');
    // The approval pill is ENQUEUED early (t0) — the operator approved while a turn was mid-flight — but
    // the brain only actually CONSUMES it on its NEXT turn, at t0+35s (delivered_at).
    const pillId = await insertMessage(JOB_A, threadId, {
      author: 'Atlas',
      author_id: 'atlas',
      author_bot_id: 'atlas',
      text: 'Plan approved — checking the base branch before starting',
      kind: 'build_event',
      created_at: t0,
      delivered_at: new Date(t0.getTime() + 35_000),
      order_at: null,
    });
    // The reply of the turn that was ALREADY in flight when the pill was enqueued — persisted (batched) at
    // turn end, t0+30s. No delivered_at/order_at: a brain-authored block orders by its own created_at.
    const replyId = await insertMessage(JOB_A, threadId, {
      author: 'Atlas',
      author_id: 'atlas',
      author_bot_id: 'atlas',
      text: 'Agreed, on it.',
      kind: 'chat',
      created_at: new Date(t0.getTime() + 30_000),
      delivered_at: null,
      order_at: null,
    });

    // Sanity: prove this genuinely reproduces the reported bug — under raw created_at ordering the pill
    // (t0) sorts BEFORE the reply (t0+30s), which is the wrong, reported behavior.
    const pillRow = await ds.query(`SELECT created_at FROM transcript_messages WHERE id = $1`, [
      pillId,
    ]);
    const replyRow = await ds.query(`SELECT created_at FROM transcript_messages WHERE id = $1`, [
      replyId,
    ]);
    expect(new Date(pillRow[0].created_at).getTime()).toBeLessThan(
      new Date(replyRow[0].created_at).getTime(),
    );

    const res = await request(server)
      .get(`/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_A}/messages`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<Record<string, unknown>>;
    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live order verbatim.
    console.log(
      'OBSERVED GET messages (scenario A) order:',
      JSON.stringify(
        body.map((m) => ({ id: m.id, text: m.text, postedAt: m.postedAt })),
        null,
        2,
      ),
    );

    const replyIdx = body.findIndex((m) => m.id === replyId);
    const pillIdx = body.findIndex((m) => m.id === pillId);
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(pillIdx).toBeGreaterThanOrEqual(0);
    // THE FIX: the pill (consumed by the brain only on the NEXT turn) renders AFTER the in-flight reply —
    // the inverse of raw created_at order.
    expect(replyIdx).toBeLessThan(pillIdx);

    // Display timestamp stays truthful — the pill's `postedAt` is still its real (early) insert time, NOT
    // its later delivered_at. Only render POSITION moved.
    expect(new Date(body[pillIdx].postedAt as string).getTime()).toBe(t0.getTime());
  });

  it('(B) mid-turn pure-UI notice deferral: order_at renders a deferred notice after the reply, timestamp unchanged', async () => {
    const threadId = await ensurePlanningThread(JOB_B);
    const t0 = new Date('2026-07-17T11:00:00.000Z');
    // A pure-UI notice posted mid-turn (t0+5s) — no stimulus/delivery, so it has no delivered_at to order
    // by. `order_at` is the escape hatch TurnHarnessFactory.persistAll stamps at turn end.
    const noticeId = await insertMessage(JOB_B, threadId, {
      author: 'System',
      author_id: 'system',
      author_bot_id: null,
      text: 'harness status notice',
      kind: 'chat',
      created_at: new Date(t0.getTime() + 5_000),
      delivered_at: null,
      order_at: new Date(t0.getTime() + 31_000), // stamped just after the turn's last block
    });
    const replyId = await insertMessage(JOB_B, threadId, {
      author: 'Atlas',
      author_id: 'atlas',
      author_bot_id: 'atlas',
      text: 'Working on it.',
      kind: 'chat',
      created_at: new Date(t0.getTime() + 30_000),
      delivered_at: null,
      order_at: null,
    });

    const res = await request(server)
      .get(`/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_B}/messages`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const body = res.body as Array<Record<string, unknown>>;
    // eslint-disable-next-line no-console -- evidence: dump the OBSERVED live order verbatim.
    console.log(
      'OBSERVED GET messages (scenario B) order:',
      JSON.stringify(
        body.map((m) => ({ id: m.id, text: m.text, postedAt: m.postedAt })),
        null,
        2,
      ),
    );

    const replyIdx = body.findIndex((m) => m.id === replyId);
    const noticeIdx = body.findIndex((m) => m.id === noticeId);
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(noticeIdx).toBeGreaterThanOrEqual(0);
    // THE FIX: the deferred notice (order_at stamped after the turn) renders AFTER the reply, even though
    // it was POSTED (created_at) before the reply persisted.
    expect(replyIdx).toBeLessThan(noticeIdx);

    // Display timestamp stays truthful — postedAt is still the real early post time, not order_at.
    expect(new Date(body[noticeIdx].postedAt as string).getTime()).toBe(t0.getTime() + 5_000);
  });
});
