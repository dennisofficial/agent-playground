/**
 * LIVE integration proof for THREAD 6 — approval-gated dispatch (rebase-check → build-start).
 *
 * Boots the REAL `AppModule` over live Postgres (mirroring `web-surface.spin-up-preview.int.test.ts`),
 * seeds a job parked at `awaiting_approval` with its durable `decision_records` row directly against
 * Postgres, then drives the approval through the restart-safe durable path
 * (`AgentSessionManager.resolveApprovalDurably` — the exact method the HTTP `/approve` endpoint falls
 * through to when there is no live in-session handle, e.g. a DB-seeded job).
 *
 * The rewire this thread introduced is that approval NO LONGER dispatches/implements synchronously —
 * instead it fires the `plan-approved` JIT lifecycle rule, which seeds Atlas the base-check instruction
 * and flips the job to `running` + activity `base_check`, leaving the build to start only when Atlas
 * later calls `dispatch_build`/`hold_build`. This proves that host-side deterministic half LIVE:
 *
 *   (a) NO synchronous dispatch on approval — neither the `JOB_DISPATCHER` (full-plan pipeline) nor the
 *       `ENGINE_RUNNER` (direct-build implement turn) is invoked;
 *   (b) exactly ONE `plan-approved` seed is delivered on `surface.inbound$`, authored by the system seed
 *       author, carrying the `seed:plan-approved:<decisionRecordId>` render row and the rebase-check /
 *       `dispatch_build` / `hold_build` instruction text;
 *   (c) the job flips `status='running'`, `activity='base_check'`, and `build_path` is committed
 *       ('plan' for a full-plan record, 'direct' for a direct-build record);
 *   (d) idempotency — re-delivering the approval (now no longer `awaiting_approval`) is a no-op: no second
 *       seed, no dispatch.
 *
 * The full brain-judgment half (auto-resolve conflict → judge validity → call `dispatch_build`/`hold_build`)
 * requires a real LLM turn + engine + sandbox and is covered by the unit specs
 * (`plan-approved.spec.ts`, `jit-host-executor.spec.ts`, `agent-session-manager.spec.ts`,
 * `brain-store.build-not-started.spec.ts`).
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DataSource } from 'typeorm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
import { AgentSessionManager, JOB_DISPATCHER } from '../brain';
import { ChatStimulusBridge } from '../stimulus/chat-stimulus.bridge';
import { WebSurface } from './web-surface';
import { SYSTEM_SEED_AUTHOR } from './chat-surface.port';
import type { InboundChatMessage } from './chat-surface.port';
import type { SeedRow } from '../domain/stimulus';

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
const ORG = '77777777-7777-4777-8777-777777777a01';
const REPO = '77777777-7777-4777-8777-777777777a02';
const PLAN_JOB = '77777777-7777-4777-8777-777777777a03';
const DIRECT_JOB = '77777777-7777-4777-8777-777777777a04';
const PLAN_DR = '77777777-7777-4777-8777-777777777a05';
const DIRECT_DR = '77777777-7777-4777-8777-777777777a06';
const OWNER_EMAIL = 'approval-dispatch-it-owner@example.test';
const PASSWORD = 'approval-dispatch-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let surface: WebSurface;
let asm: AgentSessionManager;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerId: string;

/** Spies wired in place of the real dispatch/engine seams so we can assert NO synchronous build start. */
const dispatchSpy = vi.fn(async () => undefined);
const fakeEngine = new FakeEngineRunner();
const engineRunSpy = vi.spyOn(fakeEngine, 'run');

async function register(email: string): Promise<{ id: string }> {
  const res = await request(server)
    .post('/auth/register')
    .send({ email, password: PASSWORD, name: email.split('@')[0] });
  expect(res.status).toBe(200);
  return { id: res.body.user.id as string };
}

async function purge(): Promise<void> {
  await ds
    .query(`DELETE FROM decision_records WHERE id = ANY($1)`, [
      [PLAN_DR, DIRECT_DR],
    ])
    .catch(() => undefined);
  await ds
    .query(`DELETE FROM messages WHERE job_id = ANY($1)`, [
      [PLAN_JOB, DIRECT_JOB],
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

/**
 * Seed a job parked at `awaiting_approval` + its `decision_records` row. `threadTitles` empty ⇒ direct
 * build (`isDirect`); non-empty ⇒ full-plan build — exactly how `resolveApprovalDurably` derives the path.
 */
async function seedAwaitingApproval(
  jobId: string,
  drId: string,
  threadTitles: string[],
): Promise<void> {
  // `jobs.decision_record_id` and `decision_records.job_id` are mutually-referential FKs, so seed the job
  // WITHOUT the pointer first, insert the record (its `job_id` now resolves), then stamp the pointer.
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, kind, status, activity, base_branch)
     VALUES ($1, $2, $3, 'control', 'Add rate limiting', 'feature', 'awaiting_approval', 'idle', 'main')`,
    [jobId, ORG, REPO],
  );
  await ds.query(
    `INSERT INTO decision_records (id, org_id, repo_id, job_id, overview, status, thread_titles)
     VALUES ($1, $2, $3, $4, 'Add token-bucket rate limiting to the API.', 'draft', $5)`,
    [drId, ORG, REPO, jobId, threadTitles],
  );
  await ds.query(`UPDATE jobs SET decision_record_id = $1 WHERE id = $2`, [
    drId,
    jobId,
  ]);
}

async function jobRow(
  jobId: string,
): Promise<{ status: string; activity: string; build_path: string | null }> {
  const rows = (await ds.query(
    `SELECT status, activity, build_path FROM jobs WHERE id = $1`,
    [jobId],
  )) as Array<{
    status: string;
    activity: string;
    build_path: string | null;
  }>;
  return rows[0];
}

/** Collect the seed turns the surface emits during `fn` (the seed fires synchronously off `fireLifecycle`). */
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
  // Run in the default 'web' surface binding so `CHAT_SURFACE` (what the brain + JIT host executor inject
  // and seed through) resolves to the SAME `WebSurface` instance this test captures on — under 'agent' the
  // factory (surface.module.ts) binds CHAT_SURFACE to a DIFFERENT `AgentChatSurface`, so a brain-fired seed
  // would never reach `app.get(WebSurface).inbound$`.
  const prevSurface = process.env.SURFACE;
  process.env.SURFACE = 'web';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLASSIFIER_LLM)
    .useValue(new FakeClassifierLlm())
    .overrideProvider(ENGINE_RUNNER)
    .useValue(fakeEngine)
    .overrideProvider(LocalGitService)
    .useValue(new FakeLocalGitService())
    .overrideProvider(GithubPrService)
    .useValue({})
    .overrideProvider(JOB_DISPATCHER)
    .useValue({
      dispatch: dispatchSpy,
      retry: vi.fn(async () => undefined),
      redriveThread: vi.fn(async () => undefined),
      deliverOwedHaltWakes: vi.fn(async () => undefined),
      deliverOwedDoneWakes: vi.fn(async () => undefined),
    })
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .overrideProvider(JobTitler)
    .useValue(new FakeThreadTitler())
    // Neutralize the inbound → ChatStimulus PUMP: the booted brain would otherwise consume the delivered
    // seed off `inbound$` and run the downstream base_check BRAIN TURN (the LLM-judgment half — auto-resolve
    // → judge validity → call `dispatch_build`/`hold_build`), which needs a real engine/sandbox and is
    // covered by the unit specs. This proof isolates the SYNCHRONOUS host effect of approval: the seed is
    // still delivered on `inbound$` (captured directly here), and no build starts synchronously.
    .overrideProvider(ChatStimulusBridge)
    .useValue({})
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  surface = app.get(WebSurface);
  asm = app.get(AgentSessionManager);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerId = owner.id;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Approval Dispatch Org', 'approval-dispatch-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, ownerId],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'approval-dispatch-repo', 'Approval Dispatch Repo', 'https://github.com/atlas-it/approval-dispatch.git', 'main', true)`,
    [REPO, ORG],
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

beforeEach(async () => {
  dispatchSpy.mockClear();
  engineRunSpy.mockClear();
  await ds.query(`DELETE FROM decision_records WHERE id = ANY($1)`, [
    [PLAN_DR, DIRECT_DR],
  ]);
  await ds.query(`DELETE FROM messages WHERE job_id = ANY($1)`, [
    [PLAN_JOB, DIRECT_JOB],
  ]);
  await ds.query(`DELETE FROM jobs WHERE id = ANY($1)`, [
    [PLAN_JOB, DIRECT_JOB],
  ]);
});

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

/** Assert the delivered seed IS the plan-approved base-check seed for `drId`. */
function expectPlanApprovedSeed(seed: InboundChatMessage, drId: string): void {
  expect(seed.authorId).toBe(SYSTEM_SEED_AUTHOR.id);
  const seedRow = seed.seedRow as SeedRowObject;
  expect(seedRow.chunkKey).toBe(`seed:plan-approved:${drId}`);
  expect(seedRow.label).toBe(
    'Plan approved — checking the base branch before starting',
  );
  // The rebase-check instruction: mechanical rebase → semantic validity → dispatch_build / hold_build.
  expect(seed.text).toContain('rebase');
  expect(seed.text).toContain('dispatch_build');
  expect(seed.text).toContain('hold_build');
  expect(seed.text).toContain('main'); // ctx.baseBranch is threaded into the wording
}

describe('approval-gated dispatch — approval fires the base-check JIT seed, no synchronous dispatch (live Postgres)', () => {
  it('FULL PLAN: approve → ONE plan-approved seed, NO dispatch, status=running/activity=base_check/build_path=plan', async () => {
    await seedAwaitingApproval(PLAN_JOB, PLAN_DR, ['Backend']);

    let acted!: boolean;
    const seeds = await captureSeeds(async () => {
      acted = await asm.resolveApprovalDurably(
        PLAN_JOB,
        'approve',
        ownerId,
        undefined,
        PLAN_DR,
      );
    });

    expect(acted).toBe(true);

    // (a) NO synchronous build start on either path.
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(engineRunSpy).not.toHaveBeenCalled();

    // (b) exactly ONE plan-approved seed delivered.
    expect(seeds).toHaveLength(1);
    expectPlanApprovedSeed(seeds[0], PLAN_DR);

    // (c) durable job transition.
    const row = await jobRow(PLAN_JOB);
    expect(row.status).toBe('running');
    expect(row.activity).toBe('base_check');
    expect(row.build_path).toBe('plan');
  });

  it('DIRECT BUILD: approve → ONE plan-approved seed, NO implement turn, build_path=direct', async () => {
    await seedAwaitingApproval(DIRECT_JOB, DIRECT_DR, []); // empty thread_titles ⇒ direct build

    let acted!: boolean;
    const seeds = await captureSeeds(async () => {
      acted = await asm.resolveApprovalDurably(
        DIRECT_JOB,
        'approve',
        ownerId,
        undefined,
        DIRECT_DR,
      );
    });

    expect(acted).toBe(true);

    // The direct path formerly auto-invoked runDirectBuild at approval; now it must NOT — no engine turn.
    expect(engineRunSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();

    expect(seeds).toHaveLength(1);
    expectPlanApprovedSeed(seeds[0], DIRECT_DR);

    const row = await jobRow(DIRECT_JOB);
    expect(row.status).toBe('running');
    expect(row.activity).toBe('base_check');
    expect(row.build_path).toBe('direct');
  });

  it('IDEMPOTENT: re-delivering the approval after the job is running is a no-op — no second seed, no dispatch', async () => {
    await seedAwaitingApproval(PLAN_JOB, PLAN_DR, ['Backend']);

    const first = await asm.resolveApprovalDurably(
      PLAN_JOB,
      'approve',
      ownerId,
      undefined,
      PLAN_DR,
    );
    expect(first).toBe(true);
    dispatchSpy.mockClear();
    engineRunSpy.mockClear();

    let acted!: boolean;
    const seeds = await captureSeeds(async () => {
      // Job is now 'running', no longer 'awaiting_approval' → the durable guard rejects the re-delivery.
      acted = await asm.resolveApprovalDurably(
        PLAN_JOB,
        'approve',
        ownerId,
        undefined,
        PLAN_DR,
      );
    });

    expect(acted).toBe(false);
    expect(seeds).toHaveLength(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(engineRunSpy).not.toHaveBeenCalled();

    // Still running (unchanged) — the second delivery neither re-fired nor regressed the transition.
    const row = await jobRow(PLAN_JOB);
    expect(row.status).toBe('running');
    expect(row.build_path).toBe('plan');
  });
});
