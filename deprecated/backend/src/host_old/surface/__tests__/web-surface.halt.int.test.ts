import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppOldModule } from '../../app-v1.module';
import { CLASSIFIER_LLM } from '../../decision-gate/classifier-llm';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService } from '../../git/github-pr.service';
import { LocalGitService } from '../../git/local-git.service';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobTitler } from '../../titling/job-titler.service';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

const ORG = '77777777-7777-4777-8777-777777777701';
const REPO = '77777777-7777-4777-8777-777777777702';
const HALTED_JOB = '77777777-7777-4777-8777-777777777703';
const HEALTHY_JOB = '77777777-7777-4777-8777-777777777704';
const REVIEWING_JOB = '77777777-7777-4777-8777-777777777705';
const OWNER_EMAIL = 'halt-wire-it-owner@example.test';
const PASSWORD = 'halt-wire-it-pw-12345';

const HALT_AT = '2026-07-09T00:00:00.000Z';

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
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Halt Wire Org', 'halt-wire-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'halt-wire-repo', 'Halt Wire Repo', 'https://github.com/atlas-it/halt-wire.git', 'main', true)`,
    [REPO, ORG],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, halt)
     VALUES ($1, $2, $3, 'control', 'Halted build', 'running', $4::jsonb)`,
    [HALTED_JOB, ORG, REPO, JSON.stringify({ kind: 'failed', reason: 'build broke', at: HALT_AT })],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, halt)
     VALUES ($1, $2, $3, 'control', 'Healthy build', 'running', NULL)`,
    [HEALTHY_JOB, ORG, REPO],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, activity, halt)
     VALUES ($1, $2, $3, 'control', 'Reviewing build', 'planning', 'plan_review', NULL)`,
    [REVIEWING_JOB, ORG, REPO],
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

describe('Job.halt wire — GET /web/jobs and GET /web/orgs/:orgId/repos/:repoId/jobs (live Postgres, real HTTP)', () => {
  it('GET /web/jobs (cross-org inbox): halted job keeps status as the pure phase + surfaces halt + needsYou', async () => {
    const res = await request(server).get('/web/jobs').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);

    const halted = (res.body as Array<Record<string, unknown>>).find((r) => r.jobId === HALTED_JOB);
    expect(halted).toBeDefined();
    expect(halted).toMatchObject({
      status: 'running',
      halt: { kind: 'failed', reason: 'build broke', at: HALT_AT },
      needsYou: true,
    });

    const healthy = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.jobId === HEALTHY_JOB,
    );
    expect(healthy).toBeDefined();
    expect(healthy).toMatchObject({
      status: 'running',
      halt: null,
      needsYou: false,
    });

    const reviewing = (res.body as Array<Record<string, unknown>>).find(
      (r) => r.jobId === REVIEWING_JOB,
    );
    expect(reviewing).toBeDefined();
    expect(reviewing).toMatchObject({
      status: 'planning',
      activity: 'plan_review',
      needsYou: false,
    });

    console.log('OBSERVED GET /web/jobs [reviewing]:', JSON.stringify(reviewing, null, 2));
    console.log('OBSERVED GET /web/jobs [halted]:', JSON.stringify(halted, null, 2));
    console.log('OBSERVED GET /web/jobs [healthy]:', JSON.stringify(healthy, null, 2));
  });

  it('GET /web/orgs/:orgId/repos/:repoId/jobs (per-repo list): same halt shape', async () => {
    const res = await request(server)
      .get(`/web/orgs/${ORG}/repos/${REPO}/jobs`)
      .set('Cookie', ownerCookie);
    expect(res.status).toBe(200);

    const halted = (res.body as Array<Record<string, unknown>>).find((r) => r.id === HALTED_JOB);
    expect(halted).toBeDefined();
    expect(halted).toMatchObject({
      status: 'running',
      halt: { kind: 'failed', reason: 'build broke', at: HALT_AT },
      needsYou: true,
    });

    const healthy = (res.body as Array<Record<string, unknown>>).find((r) => r.id === HEALTHY_JOB);
    expect(healthy).toBeDefined();
    expect(healthy).toMatchObject({
      status: 'running',
      halt: null,
      needsYou: false,
    });

    console.log(
      'OBSERVED GET /web/orgs/:orgId/repos/:repoId/jobs [halted]:',
      JSON.stringify(halted, null, 2),
    );
    console.log(
      'OBSERVED GET /web/orgs/:orgId/repos/:repoId/jobs [healthy]:',
      JSON.stringify(healthy, null, 2),
    );
  });
});
