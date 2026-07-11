/**
 * RETURN-PATH end-to-end (live Postgres): a verified GitHub webhook on a PR/branch an existing job owns
 * is delivered to THAT job's brain (attached as an event on the same job) instead of seeding a fresh
 * event thread — and a webhook that nothing owns still seeds a new thread (external CI).
 *
 * Real: HMAC signature verify (GithubNotificationSource), repo routing (ProjectRoutingService), intake
 * routing (StimulusIntake), and the owning-job SQL finders (StimulusStoreService) against atlas_test.
 * Stubbed: the brain sink (captures deliverEvent — we assert routing, not an LLM turn), the announcer,
 * and the titler. Drives the actual GithubEventsWebhookController front door with a signed raw body.
 */

import { createHmac } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  MessageEntity,
  StimulusEntity,
} from '../persistence/entities';
import type { EventStimulus } from '../domain';
import { EventFilterService } from '../stimulus/event-filter.service';
import { ProjectRoutingService } from '../stimulus/project-routing.service';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { StimulusIntake } from '../stimulus/stimulus-intake.service';
import { SurfaceOrchestration } from '../stimulus/surface-orchestration.service';
import { BRAIN_SINK } from '../stimulus/stimulus-consumer';
import { JobTitler } from '../titling';
import { GithubPrStateSync } from '../driver/github-pr-state-sync.service';
import { GithubCiStateSync } from '../driver/github-ci-state-sync.service';
import { GitStateReconciler } from '../driver/git-state-reconciler.service';
import type { BaseMoveMergeabilitySync } from '../driver/base-move-mergeability-sync.service';
import { GithubNotificationSource } from './github-notification.source';
import {
  GithubEventsWebhookController,
  GithubStateWebhookController,
} from './github-webhook.controller';
import type { RawBodyRequest } from './ingress-http';

const ORG_ID = '31111111-1111-4111-8111-111111111111';
const SECRET = 'gh-int-secret';
const OWNED_BRANCH = 'feature/deadbeef';

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

/** A signed raw-body request the way the front door receives it (HMAC over the EXACT bytes). */
function signedReq(
  payload: unknown,
  eventType: string,
  deliveryId: string,
): RawBodyRequest {
  const json = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', SECRET).update(Buffer.from(json)).digest('hex')}`;
  return {
    rawBody: Buffer.from(json),
    body: payload,
    headers: {
      'x-hub-signature-256': sig,
      'x-github-event': eventType,
      'x-github-delivery': deliveryId,
    },
  };
}

function failedCheckRun(headBranch: string, runId: number) {
  return {
    repository: { full_name: 'acme/web' },
    check_run: {
      id: runId,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'http://x',
      check_suite: { head_branch: headBranch },
    },
  };
}

describe('GithubEventsWebhookController return-path (live Postgres)', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let controller: GithubEventsWebhookController;
  let jobs: Repository<JobEntity>;
  let messages: Repository<MessageEntity>;
  let stimuli: Repository<StimulusEntity>;
  let repoId: string;
  const delivered: EventStimulus[] = [];

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      controllers: [GithubEventsWebhookController],
      providers: [
        ProjectRoutingService,
        StimulusStoreService,
        EventFilterService,
        StimulusIntake,
        GithubNotificationSource,
        {
          provide: GithubPrStateSync,
          useValue: { dispatch: async () => undefined },
        },
        {
          provide: GithubCiStateSync,
          useValue: { schedule: () => undefined },
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
            deliverEvent: async (s: EventStimulus) => void delivered.push(s),
            handleChat: async () => undefined,
            enqueueChat: async () => undefined,
          },
        },
      ],
    }).compile();

    controller = mod.get(GithubEventsWebhookController);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    messages = mod.get(getRepositoryToken(MessageEntity, DB_CONNECTION));
    stimuli = mod.get(getRepositoryToken(StimulusEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, 'GH Int Org', 'gh-int-org', 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'gh-int-repo', 'GH Int Repo', 'https://github.com/acme/web.git', 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    delivered.length = 0;
    await ds.query('TRUNCATE stimuli, messages, jobs RESTART IDENTITY CASCADE');
  });

  it('routes a failed CI check on an owned branch to the OWNING job (no new thread seeded)', async () => {
    const owner = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'chat',
        kind: 'feature',
        status: 'running',
        feature_branch: OWNED_BRANCH,
        title: 'the owning job',
      }),
    );

    const res = await controller.receive(
      signedReq(failedCheckRun(OWNED_BRANCH, 101), 'check_run', 'd-1'),
    );

    // Front door accepted + routed to the existing job — NOT a fresh seed.
    expect(res).toMatchObject({ status: 'accepted', jobId: owner.id });
    // No new job row was created (still exactly the one we seeded).
    expect(await jobs.count()).toBe(1);
    // The event was attached to the owning job (message + stimulus rows), and delivered to its brain.
    const attachedMsg = await messages.findOne({ where: { job_id: owner.id } });
    expect(attachedMsg?.meta).toMatchObject({
      source: 'system_event',
      eventSource: 'github',
    });
    const attachedStim = await stimuli.findOne({
      where: { job_id: owner.id, kind: 'event' },
    });
    expect(attachedStim?.dedupe_key).toBe('check_run:101');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].jobId).toBe(owner.id);
  });

  it('DROPS (no-owner) when nothing owns the branch — never seeds a job (route-only, d6)', async () => {
    const res = await controller.receive(
      signedReq(
        failedCheckRun('someone-elses-branch', 202),
        'check_run',
        'd-2',
      ),
    );

    // Route-only: a verified event nothing owns is a deliberate no-op — NOT a new job.
    expect(res).toMatchObject({ status: 'ignored', reason: 'no-owner' });
    expect(await jobs.count()).toBe(0); // nothing seeded
    expect(delivered).toHaveLength(0); // nothing delivered to any brain
  });

  it('rejects a bad signature (401) before any routing', async () => {
    const bad: RawBodyRequest = {
      ...signedReq(failedCheckRun(OWNED_BRANCH, 303), 'check_run', 'd-3'),
      headers: {
        'x-hub-signature-256': 'sha256=deadbeef',
        'x-github-event': 'check_run',
        'x-github-delivery': 'd-3',
      },
    };
    await expect(controller.receive(bad)).rejects.toMatchObject({
      status: 401,
    });
    expect(await jobs.count()).toBe(0);
  });
});

describe('GithubStateWebhookController PR-state path', () => {
  it('dispatches pull_request deltas via handlePrWebhook, with no StimulusIntake wired at all', async () => {
    const adapter = {
      source: 'github',
      handlePrWebhook: async () => ({
        outcome: 'pr-sync' as const,
        delta: {
          orgId: ORG_ID,
          repoId: 'repo-1',
          action: 'closed' as const,
          prNumber: 7,
          headRef: 'feature/deadbeef',
          url: 'https://github.com/acme/web/pull/7',
          merged: true,
        },
      }),
    } as unknown as GithubNotificationSource;
    const prSync = {
      dispatch: vi.fn(async () => undefined),
    } as unknown as GithubPrStateSync;
    const reconciler = {
      markRepoDue: vi.fn(async () => 0),
      markJobDue: vi.fn(async () => 0),
    } as unknown as GitStateReconciler;
    const baseMove = {
      schedule: vi.fn(),
    } as unknown as BaseMoveMergeabilitySync;
    const controller = new GithubStateWebhookController(
      adapter,
      prSync,
      reconciler,
      baseMove,
    );

    const res = await controller.receive({ body: {}, headers: {} });

    expect(res).toEqual({ status: 'accepted' });
    expect(prSync.dispatch).toHaveBeenCalledWith({
      orgId: ORG_ID,
      repoId: 'repo-1',
      action: 'closed',
      prNumber: 7,
      headRef: 'feature/deadbeef',
      url: 'https://github.com/acme/web/pull/7',
      merged: true,
    });
    expect(reconciler.markRepoDue).not.toHaveBeenCalled();
    expect(baseMove.schedule).not.toHaveBeenCalled();
  });

  it('dispatches a default-branch push (repo-push) to BaseMoveMergeabilitySync.schedule, never prSync/markRepoDue', async () => {
    const adapter = {
      source: 'github',
      handlePrWebhook: async () => ({
        outcome: 'repo-push' as const,
        orgId: ORG_ID,
        repoId: 'repo-1',
      }),
    } as unknown as GithubNotificationSource;
    const prSync = {
      dispatch: vi.fn(async () => undefined),
    } as unknown as GithubPrStateSync;
    const reconciler = {
      markRepoDue: vi.fn(async () => 2),
      markJobDue: vi.fn(async () => 0),
    } as unknown as GitStateReconciler;
    const baseMove = {
      schedule: vi.fn(),
    } as unknown as BaseMoveMergeabilitySync;
    const controller = new GithubStateWebhookController(
      adapter,
      prSync,
      reconciler,
      baseMove,
    );

    const res = await controller.receive({ body: {}, headers: {} });

    expect(res).toEqual({ status: 'accepted' });
    expect(baseMove.schedule).toHaveBeenCalledWith(ORG_ID, 'repo-1');
    expect(reconciler.markRepoDue).not.toHaveBeenCalled();
    expect(prSync.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a pr-rearm to GitStateReconciler.markJobDue, never prSync/baseMove', async () => {
    const adapter = {
      source: 'github',
      handlePrWebhook: async () => ({
        outcome: 'pr-rearm' as const,
        orgId: ORG_ID,
        repoId: 'repo-1',
        prNumber: 5,
        branch: 'feat/x',
      }),
    } as unknown as GithubNotificationSource;
    const prSync = {
      dispatch: vi.fn(async () => undefined),
    } as unknown as GithubPrStateSync;
    const reconciler = {
      markRepoDue: vi.fn(async () => 0),
      markJobDue: vi.fn(async () => 1),
    } as unknown as GitStateReconciler;
    const baseMove = {
      schedule: vi.fn(),
    } as unknown as BaseMoveMergeabilitySync;
    const controller = new GithubStateWebhookController(
      adapter,
      prSync,
      reconciler,
      baseMove,
    );

    const res = await controller.receive({ body: {}, headers: {} });

    expect(res).toEqual({ status: 'accepted' });
    expect(reconciler.markJobDue).toHaveBeenCalledWith(ORG_ID, 'repo-1', {
      prNumber: 5,
      branch: 'feat/x',
    });
    expect(baseMove.schedule).not.toHaveBeenCalled();
    expect(prSync.dispatch).not.toHaveBeenCalled();
  });
});
