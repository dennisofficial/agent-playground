/**
 * LIVE proof of the `create_job` host-tool `autoMode` bug fix (spec follow-up to `create_job` dependsOn):
 * an agent-spawned follow-up job now resolves its `auto_approve_mode`/`auto_merge` against the org's
 * `default_auto_approve_mode`/`default_auto_merge` instead of hard-defaulting to off/false — an omitted
 * `autoMode` field inherits the org default, a present field overrides it. Boots the REAL `AppModule` (so
 * the new `OrganizationEntity` repository wired into `BrainStoreService`/`BrainModule` resolves at Nest
 * boot with no DI regression) and drives the actual `create_job` HOST TOOL via
 * `AgentSessionManager.buildTools(stimulus)['create_job']`, mirroring the unit test in
 * `agent-session-manager.spec.ts`.
 */

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Message, TurnEnvelope } from '@shared/domain';
import { ENGINE_RUNNER } from '@shared/engine';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../app.module';
import { BrainGateway } from '../../brain-gateway';
import { CLASSIFIER_LLM } from '../../decision-gate';
import {
  FakeClassifierLlm,
  FakeEngineRunner,
  FakeLocalGitService,
  FakeThreadTitler,
} from '../../e2e/e2e-stubs';
import { GithubPrService, LocalGitService } from '../../git';
import { JobBootstrapService } from '../../job-bootstrap';
import { CredentialResolver } from '../../onboarding/credential-resolver.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { JobTitler } from '../../titling';
import { AgentSessionManager } from '../agent-session-manager.service';

const fakeCreds = {
  anthropicKey: async () => undefined,
  openaiKey: async () => undefined,
  githubToken: async () => 'fake-token',
  hostGithubToken: async () => 'fake-token',
  engineAuth: async () => ({ secret: 'test-secret' }),
};

// Fixed ids → distinct from every other int test (which purge by their own ids).
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const REPO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02';
const PARENT_JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa03';

let app: NestExpressApplication;
let ds: DataSource;
let manager: AgentSessionManager;

function stimulusFor(id: string): TurnEnvelope {
  const receivedAt = new Date('2026-07-16T00:00:00Z');
  return {
    message: {
      id,
      orgId: ORG,
      repoId: REPO,
      jobId: PARENT_JOB,
      receivedAt: receivedAt.toISOString(),
      type: 'user',
    } as unknown as Message,
    id,
    orgId: ORG,
    repoId: REPO,
    jobId: PARENT_JOB,
    receivedAt,
    body: 'spawn a follow-up',
    author: { id: 'U-OP', displayName: 'Operator' },
    replyRoute: { surfaceId: 'web', jobRef: PARENT_JOB },
  };
}

async function purge(): Promise<void> {
  await ds.query(`DELETE FROM jobs WHERE org_id = $1`, [ORG]).catch(() => undefined);
  await ds.query(`DELETE FROM repos WHERE org_id = $1`, [ORG]).catch(() => undefined);
  await ds.query(`DELETE FROM organizations WHERE id = $1`, [ORG]).catch(() => undefined);
}

async function autoColsOf(
  jobId: string,
): Promise<{ auto_approve_mode: string; auto_merge: boolean }> {
  const rows: Array<{ auto_approve_mode: string; auto_merge: boolean }> = await ds.query(
    `SELECT auto_approve_mode, auto_merge FROM jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0];
}

beforeAll(async () => {
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
    .overrideProvider(BrainGateway)
    .useValue({
      bind: () => undefined,
      openPrAtShip: async () => undefined,
      notifyThreadHalted: async () => undefined,
      notifyThreadDone: async () => undefined,
      wakeForProvisioningFailure: async () => undefined,
      wakeUnblockedJob: async () => undefined,
    })
    .compile();

  app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
  });
  app.enableShutdownHooks();
  await app.init();

  ds = app.get<DataSource>(getDataSourceToken(DB_CONNECTION));
  manager = app.get(AgentSessionManager);
  // This test proves the create_job HANDLER's autoMode resolution (the DB row it writes), not the
  // follow-up job's downstream chat turn — stub the fire-and-forget kickoff (mirrors the same stub in
  // agent-session-manager.spec.ts's create_job tests) so it never races this test's own purge() with an
  // unrelated sandbox-provisioning/transcript write against a since-deleted job row.
  vi.spyOn(manager, 'startFollowUpJob').mockResolvedValue(undefined);

  await purge();
  await ds.query(
    `INSERT INTO organizations (id, name, slug, status, default_auto_approve_mode, default_auto_merge)
     VALUES ($1, 'Auto Mode Org', 'auto-mode-org', 'active', 'ship', true)`,
    [ORG],
  );
  await ds.query(
    `INSERT INTO repos (id, org_id, slug, name, git_url, default_branch, access_ok)
     VALUES ($1, $2, 'auto-mode-repo', 'Auto Mode Repo', 'https://github.com/atlas-it/auto-mode.git', 'main', true)`,
    [REPO, ORG],
  );
  await ds.query(
    `INSERT INTO jobs (id, org_id, repo_id, origin, title, status)
     VALUES ($1, $2, $3, 'control', 'Parent job', 'open')`,
    [PARENT_JOB, ORG, REPO],
  );
  // A raw-inserted job row has no planning thread group — unlike a job created through the real
  // create/HTTP seams, which always bootstrap one. Without it, the app's background chat-delivery sweep
  // (real, not mocked here) throws trying to anchor a system event on this job and the test flakes on an
  // unrelated unhandled rejection. Bootstrap it the same way every real job-creation seam does.
  await app.get(JobBootstrapService).ensurePlanningThreadGroup(PARENT_JOB, ORG);
}, 60_000);

afterAll(async () => {
  if (ds) await purge();
  await app?.close();
});

describe('create_job host tool — autoMode resolution (live Postgres)', () => {
  it('with no autoMode, the follow-up inherits the org defaults', async () => {
    const stimulus = stimulusFor('stim-auto-mode-1');
    const result = (await manager.buildTools(stimulus)['create_job']({
      firstMessage: 'do the inherited-default follow-up',
    })) as { ok: boolean; jobId: string };

    expect(result.ok).toBe(true);
    const row = await autoColsOf(result.jobId);
    expect(row.auto_approve_mode).toBe('ship');
    expect(row.auto_merge).toBe(true);
  });

  it('with an explicit autoMode, the override wins over the org defaults', async () => {
    const stimulus = stimulusFor('stim-auto-mode-2');
    const result = (await manager.buildTools(stimulus)['create_job']({
      firstMessage: 'do the explicit-override follow-up',
      autoMode: { approveMode: 'off', merge: false },
    })) as { ok: boolean; jobId: string };

    expect(result.ok).toBe(true);
    const row = await autoColsOf(result.jobId);
    expect(row.auto_approve_mode).toBe('off');
    expect(row.auto_merge).toBe(false);
  });
});
