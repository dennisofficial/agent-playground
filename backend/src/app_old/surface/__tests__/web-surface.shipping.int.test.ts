
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

const ORG = '77777777-7777-4777-8777-777777777801';
const REPO = '77777777-7777-4777-8777-777777777802';
const SHIPPING_JOB = '77777777-7777-4777-8777-777777777803';
const BUILDING_JOB = '77777777-7777-4777-8777-777777777804';
const DONE_JOB = '77777777-7777-4777-8777-777777777805';
const OWNER_EMAIL = 'shipping-wire-it-owner@example.test';
const PASSWORD = 'shipping-wire-it-pw-12345';

const SHIP_AT = '2026-07-09T00:00:00.000Z';

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
  process.env.SURFACE = 'agent';

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
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Shipping Wire Org', 'shipping-wire-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'shipping-wire-repo', 'Shipping Wire Repo', 'https://github.com/atlas-it/shipping-wire.git', 'main', true)`,
    [REPO, ORG],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, ship_review_approved_at)
     VALUES ($1, $2, $3, 'control', 'Shipping build', 'running', $4::timestamptz)`,
    [SHIPPING_JOB, ORG, REPO, SHIP_AT],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, ship_review_approved_at)
     VALUES ($1, $2, $3, 'control', 'Building build', 'running', NULL)`,
    [BUILDING_JOB, ORG, REPO],
  );

  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status, ship_review_approved_at, pr_state, pr_number)
     VALUES ($1, $2, $3, 'control', 'Shipped build', 'done', $4::timestamptz, 'open', 7)`,
    [DONE_JOB, ORG, REPO, SHIP_AT],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('shipping wire — GET /web/jobs (live Postgres, real HTTP)', () => {
  it('projects shipping=true only for a ship-approved running job, false for a plain build and a done job', async () => {
    const res = await request(server).get('/web/jobs').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const rows = res.body as Array<Record<string, unknown>>;

    const shipping = rows.find((r) => r.jobId === SHIPPING_JOB);
    expect(shipping).toBeDefined();
    expect(shipping).toMatchObject({ status: 'running', shipping: true });

    const building = rows.find((r) => r.jobId === BUILDING_JOB);
    expect(building).toBeDefined();
    expect(building).toMatchObject({ status: 'running', shipping: false });

    const done = rows.find((r) => r.jobId === DONE_JOB);
    expect(done).toBeDefined();
    expect(done).toMatchObject({ status: 'done', shipping: false });

    console.log('OBSERVED GET /web/jobs [shipping]:', JSON.stringify(shipping, null, 2));
    console.log('OBSERVED GET /web/jobs [building]:', JSON.stringify(building, null, 2));
    console.log('OBSERVED GET /web/jobs [done]:', JSON.stringify(done, null, 2));
  });
});
