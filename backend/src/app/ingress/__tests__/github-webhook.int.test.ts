
import { EnvService } from '@core/config/env/env.service';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { EventMessage } from '@shared/domain';
import { createHmac } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import type { BaseMoveMergeabilitySync } from '../../driver/base-move-mergeability-sync.service';
import { GitStateReconciler } from '../../driver/git-state-reconciler.service';
import { GithubCiStateSync } from '../../driver/github-ci-state-sync.service';
import { GithubPrStateSync } from '../../driver/github-pr-state-sync.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  ENTITIES,
  InboundMessageEntity,
  JobEntity,
  TranscriptMessageEntity,
} from '../../persistence/entities';
import { EventFilterService } from '../../stimulus/event-filter.service';
import { ProjectRoutingService } from '../../stimulus/project-routing.service';
import { BRAIN_SINK } from '../../stimulus/stimulus-consumer';
import { StimulusIntake } from '../../stimulus/stimulus-intake.service';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { SurfaceOrchestration } from '../../stimulus/surface-orchestration.service';
import { JobTitler } from '../../titling/job-titler.service';
import { GithubNotificationSource } from '../github-notification.source';
import {
  GithubEventsWebhookController,
  GithubStateWebhookController,
} from '../github-webhook.controller';
import type { RawBodyRequest } from '../ingress-http';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';

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

function signedReq(payload: unknown, eventType: string, deliveryId: string): RawBodyRequest {
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
  let messages: Repository<TranscriptMessageEntity>;
  let stimuli: Repository<InboundMessageEntity>;
  let repoId: string;
  const delivered: EventMessage[] = [];

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      controllers: [GithubEventsWebhookController],
      providers: [
        ProjectRoutingService,
        JobBootstrapService,
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
            get: (k: string) => (k === 'GITHUB_WEBHOOK_SECRET' ? SECRET : undefined),
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
            deliverEvent: async (s: EventMessage) => void delivered.push(s),
            handleChat: async () => undefined,
            enqueueChat: async () => undefined,
          },
        },
      ],
    }).compile();

    controller = mod.get(GithubEventsWebhookController);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    messages = mod.get(getRepositoryToken(TranscriptMessageEntity, DB_CONNECTION));
    stimuli = mod.get(getRepositoryToken(InboundMessageEntity, DB_CONNECTION));

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
    await ds.query('DELETE FROM inbound_messages WHERE org_id = $1', [ORG_ID]);
    await ds.query(
      'DELETE FROM transcript_messages WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $1)',
      [ORG_ID],
    );
    await ds.query('DELETE FROM jobs WHERE org_id = $1', [ORG_ID]);
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

    expect(res).toMatchObject({ status: 'accepted', jobId: owner.id });
    expect(await jobs.countBy({ org_id: ORG_ID })).toBe(1);
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
      signedReq(failedCheckRun('someone-elses-branch', 202), 'check_run', 'd-2'),
    );

    expect(res).toMatchObject({ status: 'ignored', reason: 'no-owner' });
    expect(await jobs.countBy({ org_id: ORG_ID })).toBe(0); // nothing seeded
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
    expect(await jobs.countBy({ org_id: ORG_ID })).toBe(0);
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
    const controller = new GithubStateWebhookController(adapter, prSync, reconciler, baseMove);

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
    const controller = new GithubStateWebhookController(adapter, prSync, reconciler, baseMove);

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
    const controller = new GithubStateWebhookController(adapter, prSync, reconciler, baseMove);

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
