/**
 * End-to-end (live Postgres, booted HTTP server) proof that the `ciStatus` field exposed by BOTH REST
 * projections — the header (`DriverStoreService.getPipelineState`) and the sidebar
 * (`WebSurfaceController.allThreads`) — reflects a real webhook → debounced sync → column write.
 *
 * Drives the ACTUAL `GithubEventsWebhookController` front door over a real HTTP listener (not the
 * controller method directly), so the full `runWorkEvent` → `GithubNotificationSource.handleWorkEvent` →
 * `GithubCiStateSync.schedule` → (5s debounce) → `GithubCiStateSync.recompute` → `jobs.ci_status` write
 * loop runs for real against atlas_test, then re-reads both projections to confirm they observe the
 * write.
 */

import { createHmac } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  RepoEntity,
  UserEntity,
} from '../persistence/entities';
import { JobBootstrapService } from '../job-bootstrap';
import {
  EventFilterService,
  ProjectRoutingService,
  StimulusIntake,
  StimulusStoreService,
  SurfaceOrchestration,
} from '../stimulus';
import { BRAIN_SINK } from '../stimulus/stimulus-consumer';
import { JobTitler } from '../titling';
import { CredentialResolver } from '../onboarding';
import { GithubPrService } from '../git';
import {
  DriverStoreService,
  GithubCiStateSync,
  GithubPrStateSync,
  GitStateReconciler,
} from '../driver';
import { JobDependencyService } from '../job-deps';
import { GithubNotificationSource } from './github-notification.source';
import { GithubEventsWebhookController } from './github-webhook.controller';
import { WebSurfaceController } from '../surface/web-surface.controller';

const ORG_ID = '41111111-1111-4111-8111-111111111111';
const SECRET = 'gh-int-secret';
const OWNED_BRANCH = 'feature/ci-proj';

function dbOpts() {
  return {
    name: DB_CONNECTION,
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5433),
    username: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB,
    entities: ENTITIES,
    namingStrategy: new CustomNamingStrategy(),
    synchronize: false,
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

describe('ciStatus projections end-to-end (live Postgres, booted HTTP server)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;
  let jobs: Repository<JobEntity>;
  let repos: Repository<RepoEntity>;
  let driverStore: DriverStoreService;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      controllers: [GithubEventsWebhookController],
      providers: [
        ProjectRoutingService,
        JobBootstrapService,
        StimulusStoreService,
        EventFilterService,
        StimulusIntake,
        GithubNotificationSource,
        GithubCiStateSync,
        DriverStoreService,
        {
          provide: JobDependencyService,
          useValue: { blockersOf: async () => [] },
        },
        {
          provide: GithubPrStateSync,
          useValue: { dispatch: async () => undefined },
        },
        {
          provide: GitStateReconciler,
          useValue: { markJobDue: async () => 0 },
        },
        {
          provide: EnvService,
          useValue: {
            get: (k: string) =>
              k === 'GITHUB_WEBHOOK_SECRET' ? SECRET : undefined,
          },
        },
        {
          provide: SurfaceOrchestration,
          useValue: { announceEvent: async () => 'ts' },
        },
        { provide: JobTitler, useValue: { titleFor: async (t: string) => t } },
        {
          provide: BRAIN_SINK,
          useValue: {
            deliverEvent: async () => undefined,
            handleChat: async () => undefined,
            enqueueChat: async () => undefined,
          },
        },
        {
          provide: GithubPrService,
          useValue: {
            isRateLimited: () => false,
            getPullDetail: async () => ({
              state: 'open',
              headSha: 'sha1',
              mergeableState: 'clean',
            }),
            listCheckRuns: async () => [
              { status: 'completed', conclusion: 'success' },
              { status: 'completed', conclusion: 'success' },
            ],
            findOpenPullByHead: async () => ({ number: 42 }),
          },
        },
        {
          provide: CredentialResolver,
          useValue: {
            githubToken: async () => 'tok',
            hostGithubToken: async () => 'tok',
          },
        },
      ],
    }).compile();

    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    repos = mod.get(getRepositoryToken(RepoEntity, DB_CONNECTION));
    driverStore = mod.get(DriverStoreService);

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'GH CI Proj Org', 'gh-ci-proj-org', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'gh-ci-proj-repo', 'GH CI Proj Repo', 'https://github.com/acme/ci-status-web.git', 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    repoId = repoRows[0].id;

    app = mod.createNestApplication({ rawBody: true });
    await app.init();
    await app.listen(0);
    const rawUrl = await app.getUrl();
    baseUrl = rawUrl.replace('[::1]', '127.0.0.1').replace('::1', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE stimuli, messages, jobs RESTART IDENTITY CASCADE');
  });

  it('a signed check_run webhook debounce-syncs jobs.ci_status, observed by both the header and sidebar projections', async () => {
    const saved = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'chat',
        kind: 'feature',
        status: 'running',
        feature_branch: OWNED_BRANCH,
        pr_number: 42,
        pr_url: 'https://github.com/acme/ci-status-web/pull/42',
        ci_status: 'pending',
        title: 'ci projection job',
      }),
    );
    const jobId = saved.id;

    // ── HEADER PROJECTION (before) ──────────────────────────────────────────────────────────────
    const before = await driverStore.getPipelineState(jobId, ORG_ID);
    console.log(
      '[ci-proj] header before:',
      (before as { ciStatus?: unknown }).ciStatus,
    );
    expect((before as { ciStatus?: unknown }).ciStatus).toBe('pending');

    // ── SIDEBAR PROJECTION (before) — real WebSurfaceController.allThreads, minimal DI ─────────────
    const inst = Object.create(WebSurfaceController.prototype);
    inst.orgService = {
      listForUser: async () => [
        { id: ORG_ID, slug: 'gh-ci-proj-org', name: 'GH CI Proj Org' },
      ],
    };
    inst.jobs = jobs;
    inst.repos = repos;
    inst.jobDeps = { blockersOfManyBlocked: async () => new Map() };
    const rowsBefore = (await WebSurfaceController.prototype.allThreads.call(
      inst,
      { id: 'user-1' } as UserEntity,
    )) as Array<{ jobId: string; ciStatus?: unknown }>;
    const rowBefore = rowsBefore.find((r) => r.jobId === jobId);
    console.log('[ci-proj] sidebar before:', rowBefore?.ciStatus);
    expect(rowBefore?.ciStatus).toBe('pending');

    // ── BOOTED-SERVER 202: signed check_run over real HTTP ─────────────────────────────────────────
    const payload = {
      repository: { full_name: 'acme/ci-status-web' },
      check_run: {
        id: 999,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        html_url: 'http://x',
        check_suite: { head_branch: OWNED_BRANCH },
        pull_requests: [{ number: 42 }],
      },
    };
    const json = JSON.stringify(payload);
    const sig = `sha256=${createHmac('sha256', SECRET).update(Buffer.from(json)).digest('hex')}`;
    const res = await fetch(`${baseUrl}/webhooks/github/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'check_run',
        'x-github-delivery': 'proj-1',
      },
      body: json,
    });
    console.log('[ci-proj] webhook status:', res.status);
    expect(res.status).toBe(202);

    // Real 5s debounce inside GithubCiStateSync — real timers only (fake timers fight the pg socket).
    await new Promise((r) => setTimeout(r, 6000));

    // ── HEADER PROJECTION (after) ───────────────────────────────────────────────────────────────
    const after = await driverStore.getPipelineState(jobId, ORG_ID);
    console.log(
      '[ci-proj] header after:',
      (after as { ciStatus?: unknown }).ciStatus,
    );
    expect((after as { ciStatus?: unknown }).ciStatus).toBe('success');

    // ── SIDEBAR PROJECTION (after) ──────────────────────────────────────────────────────────────
    const rowsAfter = (await WebSurfaceController.prototype.allThreads.call(
      inst,
      { id: 'user-1' } as UserEntity,
    )) as Array<{ jobId: string; ciStatus?: unknown }>;
    const rowAfter = rowsAfter.find((r) => r.jobId === jobId);
    console.log('[ci-proj] sidebar after:', rowAfter?.ciStatus);
    expect(rowAfter?.ciStatus).toBe('success');
  }, 30_000);
});
