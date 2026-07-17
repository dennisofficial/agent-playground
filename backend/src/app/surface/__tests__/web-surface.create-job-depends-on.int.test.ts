
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { UnblockBlockerInfo } from '@shared/domain';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { BrainGateway } from '../../brain-gateway';
import { CLASSIFIER_LLM } from '../../decision-gate';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { JobDependencyService } from '../../job-deps';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobTitler } from '../../titling';
import type { InboundChatMessage } from '../chat-surface.port';
import { WebSurface } from '../web-surface';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

const ORG = '99999999-9999-4999-8999-999999999901';
const REPO = '99999999-9999-4999-8999-999999999902';
const FOREIGN_ORG = '99999999-9999-4999-8999-999999999903';
const FOREIGN_REPO = '99999999-9999-4999-8999-999999999904';
const FOREIGN_JOB = '99999999-9999-4999-8999-999999999905';

const OWNER_EMAIL = 'create-job-depends-on-it-owner@example.test';
const PASSWORD = 'depends-on-it-pw-12345';

type UnblockNoteCall = {
  jobId: string;
  orgId: string;
  repoId: string;
  blockers: UnblockBlockerInfo[];
};

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let surface: WebSurface;
let jobDeps: JobDependencyService;
let ownerCookie: string;
let noteCalls: UnblockNoteCall[];
let pumpCalls: string[];

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
    .query(`DELETE FROM job_dependencies WHERE org_id = ANY($1)`, [[ORG, FOREIGN_ORG]])
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

function jobsUrl(): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs`;
}

async function loadJobRow(jobId: string): Promise<Record<string, unknown> | undefined> {
  const rows: Array<Record<string, unknown>> = await ds.query(
    `SELECT status, activity, feature_branch FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0];
}

type SeedRow = {
  type: string | null;
  body: string;
  delivered_at: Date | null;
  lane: string | null;
  author_id: string | null;
  reply_route: Record<string, unknown> | null;
};

async function seedRows(jobId: string): Promise<SeedRow[]> {
  return ds.query(
    `SELECT type, body, delivered_at, lane, author_id, reply_route FROM inbound_messages
      WHERE job_id = $1 AND kind = 'chat' ORDER BY created_at ASC`,
    [jobId],
  );
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
    .overrideProvider(BrainGateway)
    .useValue({
      bind: () => undefined,
      openPrAtShip: async () => undefined,
      notifyThreadHalted: async () => undefined,
      notifyThreadDone: async () => undefined,
      wakeForProvisioningFailure: async () => undefined,
      recordUnblockNote: async (
        jobId: string,
        orgId: string,
        repoId: string,
        input: { blockers: UnblockBlockerInfo[] },
      ) => {
        noteCalls.push({ jobId, orgId, repoId, blockers: input.blockers });
      },
      pumpUnblockedJob: async (jobId: string) => {
        pumpCalls.push(jobId);
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
  noteCalls = [];
  pumpCalls = [];
});

describe('POST .../jobs — dependsOn (born-blocked create)', () => {
  it('rejects a malformed dependsOn id with 400 and creates no row', async () => {
    const before = await countJobs();
    const res = await request(server).post(jobsUrl()).set('Cookie', ownerCookie).send({
      firstMessage: 'depends on a malformed id',
      dependsOn: 'not-a-uuid',
    });
    expect(res.status).toBe(400);
    expect(await countJobs()).toBe(before);
  });

  it('rejects an unknown (but well-formed) dependsOn id with 404 and creates no row', async () => {
    const before = await countJobs();
    const res = await request(server).post(jobsUrl()).set('Cookie', ownerCookie).send({
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
    const rows = await seedRows(jobId);
    expect(rows.some((r) => r.reply_route?.bornBlockedSeed)).toBe(false);
  });

  it('with a LIVE blocker, is created born-blocked — no receiveFromClient, no branch, seeds queued', async () => {
    const blockerRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'the blocker job' });
    expect(blockerRes.status).toBe(201);
    const blockerId = blockerRes.body.jobId as string;
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
    expect(row?.feature_branch).toBeNull(); // no sandbox/branch provisioned while blocked
    expect(await blockersOf(jobId)).toEqual([blockerId]);

    const rows = await seedRows(jobId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.delivered_at === null)).toBe(true);
    expect(rows.every((r) => (r.lane ?? 'main') === 'main')).toBe(true);
    expect(rows.every((r) => r.type === 'follow_up_job_seed')).toBe(true);
    expect(rows.every((r) => r.author_id === 'U-SYSTEM')).toBe(true);
    expect(rows[0].reply_route?.bornBlockedSeed).toBe(true); // the provenance note
    expect(rows[1].reply_route?.bornBlockedSeed).toBeUndefined(); // the brief
    expect(rows[1].body).toBe('blocked follow-up'); // the full assembled bodyText, verbatim
  });

  it('with only an already-TERMINAL blocker, starts immediately (not blocked)', async () => {
    const terminalRes = await request(server)
      .post(jobsUrl())
      .set('Cookie', ownerCookie)
      .send({ firstMessage: 'a job whose PR already merged' });
    const terminalId = terminalRes.body.jobId as string;
    await ds.query(`UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`, [
      terminalId,
    ]);

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
    const rows = await seedRows(jobId);
    expect(rows.some((r) => r.reply_route?.bornBlockedSeed)).toBe(false);
  });

  it('with MULTIPLE live blockers, stays blocked until the LAST one resolves (records the unblock note)', async () => {
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

    await ds.query(`UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`, [a]);
    await jobDeps.onBlockerResolved(a, 'merged');
    expect((await loadJobRow(dependent))?.status).toBe('blocked');
    expect(noteCalls).toHaveLength(0);

    const parkedRows = await seedRows(dependent);
    expect(parkedRows.map((r) => r.body)).toContain('multi-blocked follow-up');

    await ds.query(`UPDATE jobs SET pr_state = 'merged', status = 'done' WHERE id = $1`, [b]);
    await jobDeps.onBlockerResolved(b, 'merged');

    const row = await loadJobRow(dependent);
    expect(row?.status).toBe('open');
    expect(pumpCalls).toContain(dependent);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].jobId).toBe(dependent);
    expect(noteCalls[0].blockers).toHaveLength(2);
    expect(noteCalls[0].blockers.map((bl) => ({ jobId: bl.jobId, how: bl.how }))).toEqual(
      expect.arrayContaining([
        { jobId: a, how: 'merged' },
        { jobId: b, how: 'merged' },
      ]),
    );
  });
});
