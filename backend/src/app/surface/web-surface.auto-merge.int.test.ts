/**
 * LIVE HTTP proof of the "Auto Merge" feature: boots the REAL `AppModule` over HTTP (supertest, real
 * cookie auth + `OrgMembershipGuard`), seeds `jobs` rows directly against live Postgres with a
 * GitHub-mergeable PR (`pr_state='open'`, `pr_mergeable='clean'`, `ci_status='success'`) and an idle
 * brain, then drives `PATCH /web/orgs/:orgId/repos/:repoId/jobs/:jobId/auto-merge` and asserts the ONE
 * merge-resolution path (`AutoMergeService.mergeNow`, reached via `maybeAutoMerge`) end to end:
 *
 *   - Enabling auto-merge on an already-green PR merges it: `mergePullRequest` is called with the
 *     configured method + the validated head sha, and `pr_state` flips to `merged`.
 *   - A green PR with auto-merge OFF still surfaces `mergeReady`/`mergeValue` on the pipeline DTO (the
 *     manual "Merge PR" card gate) but is never merged.
 *   - A GitHub rejection (`not_mergeable`) leaves the PR `open` and — the race-avoidance guarantee —
 *     never seeds a stimulus for the job (relies on the EXISTING reconciler routing instead).
 *
 * `GithubPrService` is overridden with a fake exposing `getPullDetail`/`mergePullRequest`/`deleteBranch`
 * so no real GitHub call is made. Mirrors `web-surface.auto-approve.int.test.ts` for HTTP/auth setup.
 */

import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { ChatStimulusBridge } from '../stimulus/chat-stimulus.bridge';
import { AutoMergeService } from '../driver/auto-merge.service';
import { JobBootstrapService } from '../job-bootstrap';
import { MERGE_ACTION_ID } from '../surface/approval-blocks';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => undefined,
  engineAuth: async () => ({ secret: 'test-secret' }),
};

const getPullDetail = vi.fn(
  async (_token: string, args: { number: number }) => ({
    number: args.number,
    url: `https://github.com/atlas-it/auto-merge-test/pull/${args.number}`,
    state: 'open' as const,
    mergeableState: 'clean',
    headSha: 'HEAD',
    headRef: 'atlas/feature',
  }),
);
const mergePullRequest = vi.fn(
  async (_token: string, args: { number: number }) => {
    if (args.number === 703 || args.number === 705)
      return {
        ok: false,
        reason: 'not_mergeable',
        status: 405,
        message: 'Pull Request is not mergeable',
      };
    return { ok: true, sha: 'merged-sha' };
  },
);
const deleteBranch = vi.fn(async () => undefined);
const fakePr = { getPullDetail, mergePullRequest, deleteBranch };

// Fixed ids → distinct from every other int test.
const ORG = '99999999-9999-4999-9999-999999999901';
const REPO = '99999999-9999-4999-9999-999999999902';
const MERGE_JOB = '99999999-9999-4999-9999-999999999903'; // enable auto-merge on a green PR → merges
const CARD_JOB = '99999999-9999-4999-9999-999999999904'; // green PR, auto-merge OFF → card, no merge
const NOT_MERGEABLE_JOB = '99999999-9999-4999-9999-999999999905'; // GitHub rejects the merge attempt
const APPROVE_MERGE_JOB = '99999999-9999-4999-9999-999999999906'; // synchronous manual Merge PR approve → merges
const APPROVE_MERGE_FAIL_JOB = '99999999-9999-4999-9999-999999999907'; // manual Merge PR approve, GitHub rejects → 409

const OWNER_EMAIL = 'auto-merge-it-owner@example.test';
const PASSWORD = 'auto-merge-it-pw-12345';

let app: NestExpressApplication;
let ds: DataSource;
let bootstrap: JobBootstrapService;
let server: ReturnType<NestExpressApplication['getHttpServer']>;
let ownerCookie: string;
let ownerId: string;

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

function autoMergeUrl(jobId: string): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}/auto-merge`;
}

function pipelineUrl(jobId: string): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}/pipeline`;
}

function approveUrl(jobId: string): string {
  return `/web/orgs/${ORG}/repos/${REPO}/jobs/${jobId}/approve`;
}

async function loadJobRow(
  jobId: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = (await ds.query(
    `SELECT status, pr_state, pr_number, pr_mergeable, ci_status, auto_merge, auto_merge_by, feature_branch
       FROM jobs WHERE id = $1`,
    [jobId],
  )) as Array<Record<string, unknown>>;
  return rows[0];
}

async function countStimuli(jobId: string): Promise<number> {
  const rows = (await ds.query(
    `SELECT count(*)::int AS n FROM stimuli WHERE job_id = $1`,
    [jobId],
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Seed a job with a GitHub-mergeable PR (`prMergeReady` true) and an idle brain (defaults already
 *  satisfy `brainSettled`: activity='idle', halted=false, halt=null, open_question_count=0,
 *  awaiting_secret_id=null). `prNumber` must be unique per job (distinguishes fake-PR calls). */
async function seedGreenJob(
  jobId: string,
  prNumber: number,
  title: string,
): Promise<void> {
  await ds.query(
    `INSERT INTO jobs
       (id, org_id, repo_id, origin, title, kind, status, base_branch, feature_branch,
        pr_state, pr_number, pr_mergeable, ci_status)
     VALUES ($1, $2, $3, 'control', $4, 'feature', 'running', 'main', 'atlas/feature-merge-test',
             'open', $5, 'clean', 'success')`,
    [jobId, ORG, REPO, title, prNumber],
  );
  await bootstrap.ensurePlanningThreadGroup(jobId, ORG);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 100 } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
    .useValue(fakePr)
    .overrideProvider(CredentialResolver)
    .useValue(fakeCreds)
    .overrideProvider(JobTitler)
    .useValue(new FakeThreadTitler())
    // Neutralize the inbound → ChatStimulus pump: auto-merge never seeds the brain (Decision d1), and
    // nothing here should reach a real brain turn either way.
    .overrideProvider(ChatStimulusBridge)
    .useValue({})
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.init();

  server = app.getHttpServer();
  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  bootstrap = app.get(JobBootstrapService);

  await purge();
  const owner = await register(OWNER_EMAIL);
  ownerCookie = owner.cookie;
  ownerId = owner.id;

  await ds.query(
    `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'Auto Merge Org', 'auto-merge-org', 'active')`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ORG, owner.id],
  );
  // Explicit repo-level merge defaults: `mergeNow` reads THESE (the per-job method/delete-branch columns
  // are gone), so the fixture is explicit about what CASE 1 / the manual-merge proof assert against.
  await ds.query(
    `INSERT INTO repos
       (id, org_id, slug, name, git_url, default_branch, access_ok,
        default_auto_merge_method, default_auto_merge_delete_branch)
     VALUES ($1, $2, 'auto-merge-repo', 'Auto Merge Repo', 'https://github.com/atlas-it/auto-merge-test.git',
             'main', true, 'squash', true)`,
    [REPO, ORG],
  );

  await seedGreenJob(MERGE_JOB, 701, 'Green PR, auto-merge enabled');
  await seedGreenJob(CARD_JOB, 702, 'Green PR, auto-merge off');
  await seedGreenJob(
    NOT_MERGEABLE_JOB,
    703,
    'Green PR, GitHub rejects the merge',
  );
  await seedGreenJob(
    APPROVE_MERGE_JOB,
    704,
    'Green PR, manual Merge PR approve',
  );
  await seedGreenJob(
    APPROVE_MERGE_FAIL_JOB,
    705,
    'Green PR, manual Merge PR approve that GitHub rejects',
  );

  if (prevSurface === undefined) delete process.env.SURFACE;
  else process.env.SURFACE = prevSurface;
}, 60_000);

afterAll(async () => {
  if (ds) await purge().catch(() => undefined);
  await app?.close();
});

describe('auto-merge — PATCH .../jobs/:jobId/auto-merge (live Postgres, real HTTP)', () => {
  it('CASE 1 — enabling auto-merge on an already-green PR merges it: mergePullRequest called with the configured method + validated sha, pr_state -> merged', async () => {
    const before = await loadJobRow(MERGE_JOB);
    expect(before).toMatchObject({ pr_state: 'open', auto_merge: false });

    const res = await request(server)
      .patch(autoMergeUrl(MERGE_JOB))
      .set('Cookie', ownerCookie)
      .send({ autoMerge: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, autoMerge: true });

    // The merge is fire-and-forget (`maybeAutoMerge`, triggered by the PATCH) — poll for the terminal state.
    await waitFor(async () => {
      const row = await loadJobRow(MERGE_JOB);
      return row?.pr_state === 'merged';
    });

    const after = await loadJobRow(MERGE_JOB);
    expect(after).toMatchObject({
      pr_state: 'merged',
      auto_merge: true,
      auto_merge_by: ownerId,
    });
    expect(mergePullRequest).toHaveBeenCalledWith(
      'fake-token',
      expect.objectContaining({ number: 701, method: 'squash', sha: 'HEAD' }),
    );
    // eslint-disable-next-line no-console -- evidence: OBSERVED DB row after the auto-merge.
    console.log(
      'OBSERVED CASE 1 DB row after auto-merge:',
      JSON.stringify(after),
    );
  });

  it('CASE 2 — a green PR with auto-merge OFF surfaces mergeReady/mergeValue on the pipeline DTO, but is never merged', async () => {
    const pipe = await request(server)
      .get(pipelineUrl(CARD_JOB))
      .set('Cookie', ownerCookie);
    expect(pipe.status).toBe(200);
    expect(pipe.body).toMatchObject({ mergeReady: true });
    expect(pipe.body.mergeValue).toContain(CARD_JOB);

    // Drive the merge-ready evaluator directly (a legitimate trigger — the reconciler/CI-sync webhook
    // call the exact same seam) so the durable "Merge PR" card materializes without enabling auto-merge.
    const autoMerge = app.get(AutoMergeService);
    await autoMerge.maybeAutoMerge(CARD_JOB);

    const cardRows = (await ds.query(
      `SELECT card FROM messages WHERE job_id = $1 AND ts = $2 AND kind = 'card'`,
      [CARD_JOB, `merge-ready:${CARD_JOB}`],
    )) as Array<{ card: unknown }>;
    expect(cardRows).toHaveLength(1);

    await settle();
    const after = await loadJobRow(CARD_JOB);
    expect(after).toMatchObject({ pr_state: 'open', auto_merge: false });
    expect(mergePullRequest).not.toHaveBeenCalledWith(
      'fake-token',
      expect.objectContaining({ number: 702 }),
    );
  });

  it('CASE 3 — GitHub rejects the merge (not_mergeable): pr_state stays open and NO stimulus is seeded for the job (race-avoidance)', async () => {
    const stimuliBefore = await countStimuli(NOT_MERGEABLE_JOB);

    const res = await request(server)
      .patch(autoMergeUrl(NOT_MERGEABLE_JOB))
      .set('Cookie', ownerCookie)
      .send({ autoMerge: true });

    expect(res.status).toBe(200);

    // Let the fire-and-forget merge attempt run its course, then assert nothing changed.
    await waitFor(async () =>
      mergePullRequest.mock.calls.some(
        ([, args]) => (args as { number?: number }).number === 703,
      ),
    );
    const after = await loadJobRow(NOT_MERGEABLE_JOB);
    expect(after).toMatchObject({ pr_state: 'open', auto_merge: true });

    const stimuliAfter = await countStimuli(NOT_MERGEABLE_JOB);
    expect(stimuliAfter).toBe(stimuliBefore);
    // eslint-disable-next-line no-console
    console.log(
      `OBSERVED CASE 3: pr_state stayed "${String(after?.pr_state)}", stimuli count unchanged (${stimuliAfter})`,
    );
  });

  it('CASE 4 — foreign/missing job: 404', async () => {
    const res = await request(server)
      .patch(autoMergeUrl('00000000-0000-4000-8000-000000000000'))
      .set('Cookie', ownerCookie)
      .send({ autoMerge: true });
    expect(res.status).toBe(404);
  });
});

describe('auto-merge — POST .../jobs armed at creation (live Postgres, real HTTP)', () => {
  const createUrl = `/web/orgs/${ORG}/repos/${REPO}/jobs`;

  async function createJob(body: Record<string, unknown>): Promise<string> {
    const res = await request(server)
      .post(createUrl)
      .set('Cookie', ownerCookie)
      .send(body);
    expect(res.status).toBe(201);
    expect(typeof res.body.jobId).toBe('string');
    return res.body.jobId as string;
  }

  it('CREATE 1 — autoMerge at creation arms the toggle and records who armed it', async () => {
    const jobId = await createJob({
      firstMessage: 'Add creation-time auto-merge.',
      autoMerge: true,
    });

    const row = await loadJobRow(jobId);
    expect(row).toMatchObject({
      auto_merge: true,
      auto_merge_by: ownerId,
    });
    // eslint-disable-next-line no-console -- evidence: OBSERVED DB row of the newly-created job.
    console.log(
      'OBSERVED CREATE 1 DB row (created with autoMerge armed):',
      JSON.stringify(row),
    );
  });

  it('CREATE 2 — absent autoMerge leaves the toggle off', async () => {
    const jobId = await createJob({
      firstMessage: 'Plain job, no auto-merge.',
    });
    const row = await loadJobRow(jobId);
    expect(row).toMatchObject({
      auto_merge: false,
      auto_merge_by: null,
    });
  });
});

describe('manual Merge PR — POST .../jobs/:jobId/approve is SYNCHRONOUS (live Postgres, real HTTP)', () => {
  it('MERGE APPROVE 1 — the approve response only resolves AFTER the merge completes: pr_state is already "merged" the instant the request settles', async () => {
    const before = await loadJobRow(APPROVE_MERGE_JOB);
    expect(before).toMatchObject({ pr_state: 'open' });

    const res = await request(server)
      .post(approveUrl(APPROVE_MERGE_JOB))
      .set('Cookie', ownerCookie)
      .send({
        actionId: MERGE_ACTION_ID,
        value: JSON.stringify({ jobId: APPROVE_MERGE_JOB }),
      });

    // 2xx ONLY once the merge finished — the endpoint awaits `mergeNow`, so no polling is needed: the
    // terminal state is observable the moment the awaited response resolves.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.body).toEqual({ ok: true, jobId: APPROVE_MERGE_JOB });

    const after = await loadJobRow(APPROVE_MERGE_JOB);
    expect(after).toMatchObject({ pr_state: 'merged' });
    expect(mergePullRequest).toHaveBeenCalledWith(
      'fake-token',
      expect.objectContaining({ number: 704, method: 'squash', sha: 'HEAD' }),
    );
    // eslint-disable-next-line no-console -- evidence: OBSERVED synchronous merge (status + terminal row).
    console.log(
      `OBSERVED MERGE APPROVE 1: status ${res.status}, pr_state "${String(after?.pr_state)}" immediately after the awaited response`,
    );
  });

  it('MERGE APPROVE 2 — a GitHub-rejected merge surfaces as a 409 and the PR stays open (no false success)', async () => {
    const res = await request(server)
      .post(approveUrl(APPROVE_MERGE_FAIL_JOB))
      .set('Cookie', ownerCookie)
      .send({
        actionId: MERGE_ACTION_ID,
        value: JSON.stringify({ jobId: APPROVE_MERGE_FAIL_JOB }),
      });

    expect(res.status).toBe(409);

    const after = await loadJobRow(APPROVE_MERGE_FAIL_JOB);
    expect(after).toMatchObject({ pr_state: 'open' });
    // eslint-disable-next-line no-console -- evidence: OBSERVED failed merge (non-2xx + PR still open).
    console.log(
      `OBSERVED MERGE APPROVE 2: status ${res.status}, pr_state stayed "${String(after?.pr_state)}"`,
    );
  });
});
