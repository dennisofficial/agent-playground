
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
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobTitler } from '../../titling';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

type CloseCall = { token: string; owner: string; repo: string; number: number };
const gh = {
  calls: [] as CloseCall[],
  shouldThrow: false,
  async closePullRequest(
    token: string,
    { owner, repo, number }: { owner: string; repo: string; number: number },
  ): Promise<void> {
    this.calls.push({ token, owner, repo, number });
    if (this.shouldThrow) {
      throw new Error('GitHub refused to close PR #999 (403): Resource not accessible');
    }
  },
};

const ORG = '88888888-8888-4888-8888-888888888801';
const REPO = '88888888-8888-4888-8888-888888888802';
const JOB_CLOSE_OK = '88888888-8888-4888-8888-888888888803';
const JOB_CLOSE_FAIL = '88888888-8888-4888-8888-888888888804';
const JOB_LEAVE = '88888888-8888-4888-8888-888888888805';
const OWNER_EMAIL = 'delete-pr-it-owner@example.test';
const PASSWORD = 'delete-pr-it-pw-12345';

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

async function seedOpenPrJob(id: string, prNumber: number): Promise<void> {
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, pr_url, pr_number, pr_state)
     VALUES ($1, $2, $3, 'control', 'Open PR job', 'running', $4, $5, 'open')`,
    [id, ORG, REPO, `https://github.com/acme/app/pull/${prNumber}`, prNumber],
  );
}

async function jobRow(id: string): Promise<{ status: string } | undefined> {
  const rows = (await ds.query(`SELECT status FROM jobs WHERE id = $1`, [id])) as Array<{
    status: string;
  }>;
  return rows[0];
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
    .useValue(gh)
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
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Delete PR Org', 'delete-pr-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'delete-pr-repo', 'Delete PR Repo', 'https://github.com/acme/app.git', 'main', true)`,
    [REPO, ORG],
  );

  await seedOpenPrJob(JOB_CLOSE_OK, 101);
  await seedOpenPrJob(JOB_CLOSE_FAIL, 102);
  await seedOpenPrJob(JOB_LEAVE, 103);

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('DELETE /web/orgs/:orgId/repos/:repoId/jobs/:jobId?prAction=… (live Postgres, real HTTP)', () => {
  it('prAction=close + GitHub close succeeds → 200, PR close invoked, job claimed for deletion', async () => {
    gh.shouldThrow = false;
    gh.calls = [];

    const res = await request(server)
      .delete(`/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_CLOSE_OK}?prAction=close`)
      .set('Cookie', ownerCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(gh.calls).toEqual([{ token: 'fake-token', owner: 'acme', repo: 'app', number: 101 }]);
    const row = await jobRow(JOB_CLOSE_OK);
    expect(row === undefined || row.status === 'deleting').toBe(true);

    console.log(
      'OBSERVED close-ok:',
      JSON.stringify({ status: res.status, body: res.body, ghCalls: gh.calls, row }, null, 2),
    );
  });

  it('prAction=close + GitHub close FAILS → 502 and the job is NOT deleted (no silent orphan)', async () => {
    gh.shouldThrow = true;
    gh.calls = [];

    const res = await request(server)
      .delete(`/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_CLOSE_FAIL}?prAction=close`)
      .set('Cookie', ownerCookie);

    expect(res.status).toBe(502);
    expect(gh.calls).toEqual([{ token: 'fake-token', owner: 'acme', repo: 'app', number: 102 }]);
    const row = await jobRow(JOB_CLOSE_FAIL);
    expect(row).toBeDefined();
    expect(row?.status).toBe('running');

    console.log(
      'OBSERVED close-fail:',
      JSON.stringify({ status: res.status, body: res.body, ghCalls: gh.calls, row }, null, 2),
    );
  });

  it('prAction=leave on an open-PR job → 200, GitHub never called, delete proceeds', async () => {
    gh.shouldThrow = false;
    gh.calls = [];

    const res = await request(server)
      .delete(`/web/orgs/${ORG}/repos/${REPO}/jobs/${JOB_LEAVE}?prAction=leave`)
      .set('Cookie', ownerCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(gh.calls).toEqual([]);
    const row = await jobRow(JOB_LEAVE);
    expect(row === undefined || row.status === 'deleting').toBe(true);

    console.log(
      'OBSERVED leave:',
      JSON.stringify({ status: res.status, body: res.body, ghCalls: gh.calls, row }, null, 2),
    );
  });

  it('rejects an invalid prAction without claiming the delete', async () => {
    const jobId = '88888888-8888-4888-8888-888888888806';
    await seedOpenPrJob(jobId, 104);
    gh.shouldThrow = false;
    gh.calls = [];

    const res = await request(server)
      .delete(`/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}?prAction=merge`)
      .set('Cookie', ownerCookie);

    expect(res.status).toBe(400);
    expect(gh.calls).toEqual([]);
    const row = await jobRow(jobId);
    expect(row?.status).toBe('running');
  });
});
