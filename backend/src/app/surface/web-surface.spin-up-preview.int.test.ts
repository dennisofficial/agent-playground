/**
 * LIVE HTTP proof for the "Spin up preview" server-side seeder: boots the REAL `AppModule` over HTTP
 * (supertest, real cookie auth + `OrgMembershipGuard`), seeds a job parked at the ship gate with its
 * durable ship card directly against live Postgres, then POSTs
 * `.../jobs/:jobId/spin-up-preview` and asserts the endpoint's full contract:
 *
 *   - at the gate, FIRST click → 201 `{ ok:true, ts }`, stamps the ship card `previewRequestedAt`, and
 *     emits ONE `SYSTEM_SEED_AUTHOR` seed turn carrying the full preview procedure + the
 *     `seed:preview:<jobId>` render row (captured off `surface.inbound$`);
 *   - a SECOND click → 201 `{ ok:true, ts:'' }`, no second seed (idempotent double-click);
 *   - a job NOT at `awaiting_ship_review` → 201 `{ ok:false, ts:'' }`, no stamp, no seed.
 *
 * (The whole web-surface controller returns Nest's default 201 for POSTs — no `@HttpCode` anywhere; the
 * JSON body is the contract, mirroring `answerQuestion`/`provideSecret`.)
 *
 * Mirrors `web-surface.shipping.int.test.ts` for HTTP/auth setup.
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
import { DB_CONNECTION } from '../persistence/database.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../e2e/e2e-stubs';
import { JobTitler } from '../titling';
import { CredentialResolver } from '../onboarding/credential-resolver.service';
import { WorkspaceConfigStore } from '../onboarding/workspace-config.store';
import { JobBootstrapService } from '../job-bootstrap';
import { WebSurface } from './web-surface';
import { webShipReviewCard } from './web-approval-card';
import { SYSTEM_SEED_AUTHOR } from './chat-surface.port';
import type { InboundChatMessage } from './chat-surface.port';
import type { SeedRow } from '../domain/stimulus';
import { PREVIEW_PREP_SEED_BODY } from '../prompt-kit';

/** The visible-row form of `SeedRow` (excludes the `'skip'` sentinel). */
type SeedRowObject = Exclude<SeedRow, 'skip'>;

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG = '77777777-7777-4777-8777-777777777901';
const REPO = '77777777-7777-4777-8777-777777777902';
const GATE_JOB = '77777777-7777-4777-8777-777777777903';
const RUNNING_JOB = '77777777-7777-4777-8777-777777777904';
const OWNER_EMAIL = 'spin-up-preview-it-owner@example.test';
const PASSWORD = 'spin-up-preview-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let surface: WebSurface;
let configStore: WorkspaceConfigStore;
let bootstrap: JobBootstrapService;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;

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
    .query(`DELETE FROM messages WHERE job_id = ANY($1)`, [
      [GATE_JOB, RUNNING_JOB],
    ])
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

async function seedShipCardRow(jobId: string): Promise<void> {
  const threadId = await bootstrap.planningThreadId(jobId);
  const card = webShipReviewCard({
    jobId,
    title: 'Ready to ship',
    summary: 'The build is ready.',
  });
  await ds.query(
    `INSERT INTO messages (job_id, thread_id, author, author_id, author_bot_id, text, kind, ts, card)
     VALUES ($1, $2, 'Atlas', 'atlas', 'atlas', 'Ready to ship', 'card', $3, $4::jsonb)`,
    [jobId, threadId, `ship-review:${jobId}`, JSON.stringify(card)],
  );
}

async function shipCard(
  jobId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = (await ds.query(
    `SELECT card FROM messages WHERE job_id = $1 AND ts = $2 AND kind = 'card' LIMIT 1`,
    [jobId, `ship-review:${jobId}`],
  )) as Array<{ card: Record<string, unknown> }>;
  return rows[0]?.card;
}

function previewUrl(jobId: string): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}/spin-up-preview`;
}

/** Collect the seed turns the surface emits during `fn` (the Subject fires synchronously on POST). */
async function captureSeeds(
  fn: () => Promise<void>,
): Promise<InboundChatMessage[]> {
  const seeds: InboundChatMessage[] = [];
  const sub = surface.inbound$.subscribe((m) => {
    if (m.seed) seeds.push(m);
  });
  try {
    await fn();
  } finally {
    sub.unsubscribe();
  }
  return seeds;
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

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  surface = app.get(WebSurface);
  configStore = app.get(WorkspaceConfigStore);
  bootstrap = app.get(JobBootstrapService);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Spin Up Preview Org', 'spin-up-preview-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'spin-up-preview-repo', 'Spin Up Preview Repo', 'https://github.com/atlas-it/spin-up-preview.git', 'main', true)`,
    [REPO, ORG],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

beforeEach(async () => {
  // Fresh cards/jobs per test — each `it` seeds the exact status it needs.
  await ds.query(`DELETE FROM messages WHERE job_id = ANY($1)`, [
    [GATE_JOB, RUNNING_JOB],
  ]);
  await ds.query(`DELETE FROM jobs WHERE id = ANY($1)`, [
    [GATE_JOB, RUNNING_JOB],
  ]);
  // No stored preview recipe by default — each `it` that needs one sets it explicitly.
  await configStore.setPreviewInstructions(ORG, REPO, null);
});

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('spin-up-preview — POST .../jobs/:jobId/spin-up-preview (live Postgres, real HTTP)', () => {
  async function seedGateJob(): Promise<void> {
    await ds.query(
      `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity)
       VALUES ($1, $2, $3, 'control', 'Ready build', 'feature', 'awaiting_ship_review', 'idle')`,
      [GATE_JOB, ORG, REPO],
    );
    await bootstrap.ensurePlanningStage(GATE_JOB, ORG);
    await seedShipCardRow(GATE_JOB);
  }

  it('first click at the gate: 200 {ok:true,ts}, stamps the card, emits ONE full-body preview seed', async () => {
    await seedGateJob();

    let res!: request.Response;
    const seeds = await captureSeeds(async () => {
      res = await request(server)
        .post(previewUrl(GATE_JOB))
        .set('Cookie', ownerCookie);
    });

    // The whole web-surface controller returns 201 for POSTs (no `@HttpCode`); the body is the contract.
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ts).toBe('string');
    expect(res.body.ts.length).toBeGreaterThan(0);

    // (b) the ship card is stamped.
    const card = await shipCard(GATE_JOB);
    expect(typeof card?.previewRequestedAt).toBe('string');

    // (c) exactly one SYSTEM seed carrying the full procedure + the preview render row.
    expect(seeds).toHaveLength(1);
    const seed = seeds[0];
    expect(seed.authorId).toBe(SYSTEM_SEED_AUTHOR.id);
    expect(seed.text).toContain(PREVIEW_PREP_SEED_BODY);
    const seedRow = seed.seedRow as SeedRowObject;
    expect(seedRow.chunkKey).toBe(`seed:preview:${GATE_JOB}`);
    expect(seedRow.label).toBe('Spin up preview requested');
  });

  it('with a stored recipe: the seed splices the saved body in a ```md fence + the "update it" footer', async () => {
    const recipe =
      'docker compose up -d\npnpm migrate\npnpm seed\nOpen https://preview.example/dashboard';
    await configStore.setPreviewInstructions(ORG, REPO, recipe);
    await seedGateJob();

    const seeds = await captureSeeds(async () => {
      await request(server)
        .post(previewUrl(GATE_JOB))
        .set('Cookie', ownerCookie);
    });

    expect(seeds).toHaveLength(1);
    const text = seeds[0].text;
    expect(text).toContain(PREVIEW_PREP_SEED_BODY);
    expect(text).toContain('```md\n' + recipe + '\n```');
    expect(text).toContain('UPDATE it with `write_preview_instructions`');
    expect(text).toContain('REPO-scoped, JOB-AGNOSTIC memory');
  });

  it('with no stored recipe: the seed nudges saving one', async () => {
    await seedGateJob();

    const seeds = await captureSeeds(async () => {
      await request(server)
        .post(previewUrl(GATE_JOB))
        .set('Cookie', ownerCookie);
    });

    expect(seeds).toHaveLength(1);
    const text = seeds[0].text;
    expect(text).toContain(PREVIEW_PREP_SEED_BODY);
    expect(text).toContain('(no preview recipe saved yet)');
    expect(text).toContain('SAVE the exact repeatable stand-up procedure');
    expect(text).toContain('REPO-scoped, JOB-AGNOSTIC memory');
  });

  it('second click: 200 {ok:true,ts:""} idempotent — no second seed, stamp unchanged', async () => {
    await seedGateJob();
    await request(server).post(previewUrl(GATE_JOB)).set('Cookie', ownerCookie);
    const firstStamp = (await shipCard(GATE_JOB))?.previewRequestedAt;

    let res!: request.Response;
    const seeds = await captureSeeds(async () => {
      res = await request(server)
        .post(previewUrl(GATE_JOB))
        .set('Cookie', ownerCookie);
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, ts: '' });
    expect(seeds).toHaveLength(0);
    expect((await shipCard(GATE_JOB))?.previewRequestedAt).toBe(firstStamp);
  });

  it('not at the gate (status running): 200 {ok:false}, no stamp, no seed', async () => {
    await ds.query(
      `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity)
       VALUES ($1, $2, $3, 'control', 'Building build', 'feature', 'running', 'build')`,
      [RUNNING_JOB, ORG, REPO],
    );
    await bootstrap.ensurePlanningStage(RUNNING_JOB, ORG);
    await seedShipCardRow(RUNNING_JOB);

    let res!: request.Response;
    const seeds = await captureSeeds(async () => {
      res = await request(server)
        .post(previewUrl(RUNNING_JOB))
        .set('Cookie', ownerCookie);
    });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(false);
    expect(seeds).toHaveLength(0);
    expect((await shipCard(RUNNING_JOB))?.previewRequestedAt).toBeUndefined();
  });
});
