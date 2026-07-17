/**
 * Live-Postgres proof of the sidebar build-stage progress aggregate (`build_stages_done` /
 * `build_stages_total`): `DriverStoreService.recomputeBuildStageProgress` derives `done`/`total` from
 * live `threads.status`, writes it change-gated onto the `jobs` row, and the value round-trips through
 * the real `GET /web/jobs` HTTP surface (mirrors `web-surface.shipping.int.test.ts` for HTTP/auth setup).
 *
 * Seeds a job with 4 build/direct_build thread groups — A (all builders done), B (last builder
 * auto_fixing, rest done — the anti-regression case), C (a builder still executing), D (zero builder
 * threads yet) — plus one non-build (master_review) thread group that must be ignored entirely, and
 * asserts:
 *   - `recomputeBuildStageProgress` derives done=2, total=4 on the `jobs` row;
 *   - `GET /web/jobs` projects `buildStagesDone`/`buildStagesTotal` for that row;
 *   - change-gating: flipping B's `auto_fixing` builder to `done` (the same overall "done" set) leaves
 *     the count unchanged at 2/4 and the write is a genuine no-op (`updated_at` untouched).
 */

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobEntity } from '../../persistence/entities';
import { JobTitler } from '../../titling';
import { CLASSIFIER_LLM } from '../decision-gate';
import { DriverStoreService } from '../driver-store.service';

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
const OWNER_EMAIL = 'build-stage-progress-it-owner@example.test';
const PASSWORD = 'build-stage-progress-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let jobs: Repository<JobEntity>;
let store: DriverStoreService;
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
  jobs = app.get(getRepositoryToken(JobEntity, DB_CONNECTION));
  store = app.get(DriverStoreService);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Build Stage Progress Org', 'build-stage-progress-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'build-stage-progress-repo', 'Build Stage Progress Repo', 'https://github.com/atlas-it/build-stage-progress.git', 'main', true)`,
    [REPO, ORG],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('DriverStoreService.recomputeBuildStageProgress (live Postgres + GET /web/jobs)', () => {
  it('derives done=2/total=4, round-trips through GET /web/jobs, and is change-gated (no regression, no-op)', async () => {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG,
        repo_id: REPO,
        origin: 'control',
        title: 'build-stage progress',
        kind: 'feature',
        status: 'running',
        base_branch: 'main',
      }),
    );

    const buildGroup = (kind: 'build' | 'direct_build', title: string) =>
      store.createThreadGroup({ jobId: job.id, orgId: ORG, kind, title });
    // Root threads share a JOB-GLOBAL ordinal uniqueness constraint (`uq_threads_job_parent_ordinal`),
    // so each builder across every thread group needs its own explicit, non-colliding ordinal — the
    // per-thread-group auto-ordinal default would collide across sibling thread groups.
    let nextOrdinal = 10;
    const builder = (threadGroupId: string, brief: string) =>
      store.createThreadInThreadGroup({
        threadGroupId,
        jobId: job.id,
        orgId: ORG,
        role: 'builder',
        brief,
        ordinal: (nextOrdinal += 10),
      });

    // Group A — all builders done → counts as done.
    const groupA = await buildGroup('build', 'A');
    const a1 = await builder(groupA.id, 'A leg 1');
    await store.setThreadStatus(a1.id, 'done');

    // Group B — last builder auto_fixing (mid-review), rest done → STILL counts as done (the
    // anti-regression case: builder work is finished, review just hasn't wrapped up yet).
    const groupB = await buildGroup('direct_build', 'B');
    const b1 = await builder(groupB.id, 'B leg 1');
    const b2 = await builder(groupB.id, 'B leg 2');
    await store.setThreadStatus(b1.id, 'done');
    await store.setThreadStatus(b2.id, 'auto_fixing');

    // Group C — a builder still executing → NOT done.
    const groupC = await buildGroup('build', 'C');
    const c1 = await builder(groupC.id, 'C leg 1');
    await store.setThreadStatus(c1.id, 'executing');

    // Group D — zero builder threads yet → NOT done (pre-creation guard).
    await buildGroup('build', 'D');

    // A non-build thread group must be ignored entirely (not counted in total).
    await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG,
      kind: 'master_review',
    });

    await store.recomputeBuildStageProgress(job.id);

    const row = await jobs.findOneOrFail({ where: { id: job.id } });
    expect(row.build_stages_done).toBe(2);
    expect(row.build_stages_total).toBe(4);

    const res = await request(server).get('/web/jobs').set('Cookie', ownerCookie);
    expect(res.status).toBe(200);
    const wireRow = (res.body as Array<Record<string, unknown>>).find((r) => r.jobId === job.id);
    expect(wireRow).toMatchObject({ buildStagesDone: 2, buildStagesTotal: 4 });

    // Change-gating: flip B's auto_fixing builder to `done` — the DERIVED done/total are unchanged
    // (still 2/4), so the IS DISTINCT FROM guard must skip the write entirely (updated_at untouched).
    await store.setThreadStatus(b2.id, 'done');
    const before = await jobs.findOneOrFail({ where: { id: job.id } });
    await store.recomputeBuildStageProgress(job.id);
    const after = await jobs.findOneOrFail({ where: { id: job.id } });
    expect(after.build_stages_done).toBe(2);
    expect(after.build_stages_total).toBe(4);
    expect(after.updated_at).toEqual(before.updated_at);

    // A second identical call is also a no-op.
    await store.recomputeBuildStageProgress(job.id);
    const again = await jobs.findOneOrFail({ where: { id: job.id } });
    expect(again.updated_at).toEqual(before.updated_at);
  });
});
