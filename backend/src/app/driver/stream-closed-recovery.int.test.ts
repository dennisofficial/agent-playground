/**
 * Live-infra proof for commit 8ba531d6 ("Harden engine turn loop against 'Stream closed' storms"): when the
 * IN-SANDBOX engine circuit-breaker trips mid-turn, `redis-engine-runner` rewraps it as
 * `in-sandbox engine turn failed: Error: engine stream closed: control channel severed mid-turn
 * (circuit-breaker)` and throws it out of `TurnRunnerService.runTurn`. That throw is NOT an HTTP-visible
 * event — it severs the stdin control channel, so it can only be faithfully reproduced by a FAKE engine
 * seam that throws the exact wrapped message, exactly like `thread-driver.service.spec.ts`'s "SILENTLY
 * RE-DRIVES the lane on the d1 stream-closed circuit-breaker throw" unit test does.
 *
 * This test boots the REAL `ThreadDriver` + the REAL `DriverStoreService` against LIVE Postgres (this
 * project's atlas_test schema — every job/thread/step row below is a genuine TypeORM write/read), with a
 * FAKE `TurnRunnerService` standing in for the engine seam (git/GitHub/sandbox/docker collaborators are
 * canned fakes, mirroring the unit spec's `assemble()` harness — the point under test is the driver's
 * `TRANSIENT_ERROR_RE` classification + `runJobWithTransientRetry` retry loop, driven over REAL DB rows, not
 * docker/git plumbing). It proves the lane SELF-HEALS: the first orchestrator turn throws the wrapped
 * stream-closed error, the driver classifies it transient (never `failed`), silently re-drives on a FRESH
 * turn (read back from Postgres — the retried run resumes the SAME persisted step/thread rows), and the job
 * reaches `done`, all readable from the live `jobs`/`threads`/`steps` tables.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, JobEntity, ThreadEntity, DecisionRecordEntity } from '../persistence/entities';
import { JobDependencyService } from '../job-deps';
import { DriverStoreService } from './driver-store.service';
import { ThreadDriver } from './thread-driver.service';
import { BuildShipService } from './build-ship.service';
import type { DriverRepoResolver, ResolvedRepo } from './repo-resolver';
import type { PlanVisibilityService } from '../decision-gate';
import type { AutoFixStage } from '../autofix';
import type { GithubPrService, LocalGitService, FeatureSandbox, ProjectRepo } from '../git';
import type { TurnRunnerService } from '../runner';
import type { BlockSink, ChatSurface, LiveTurnStore, TaskEventSink } from '../surface';
import { TurnHarnessFactory } from '../surface';
import type { ToolBridgeOptions } from '../engine';
import type { CredentialResolver } from '../onboarding';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import type { LeaderElectionService } from '../cluster';
import type { LiveVerificationJudge } from './live-verification-judge';
import type { StaticVerificationJudge } from './static-verification-judge';

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

const ORG_ID = '31111111-1111-4111-8111-111111111111';
const REPO: ProjectRepo = {
  repoId: 'stream-closed-proj',
  gitUrl: 'https://github.com/acme/stream-closed',
  defaultBranch: 'main',
  repoPath: '/repos/stream-closed-proj',
};
const RESOLVED: ResolvedRepo = {
  projectRepo: REPO,
  owner: 'acme',
  repo: 'stream-closed',
  defaultBranch: 'main',
  token: 'ghtok',
};

/** The EXACT wrapped shape the engine circuit-breaker produces (commit 8ba531d6's own error text). */
const STREAM_CLOSED_THROW =
  'in-sandbox engine turn failed: Error: engine stream closed: control channel severed mid-turn (circuit-breaker)';

/** A fake `TurnRunnerService`: throws the wrapped stream-closed error on the FIRST `runTurn` (the "storm"),
 *  then completes the thread cleanly via `complete_thread` on the retried, fresh turn. Mirrors
 *  `thread-driver.service.spec.ts`'s `makeTurn({ transientFailures: 1, transientMessage })`. */
function makeStreamClosedTurn(): {
  turn: TurnRunnerService;
  calls: Array<{ mode: string; stepId?: string | null }>;
} {
  let remainingFailures = 1;
  const calls: Array<{ mode: string; stepId?: string | null }> = [];
  const turn = {
    runTurn: vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        toolBridge?: ToolBridgeOptions;
      }) => {
        calls.push({ mode: input.mode, stepId: input.stepId });
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          // The circuit-breaker throw — the "stream closed" storm this test proves the driver self-heals.
          throw new Error(STREAM_CLOSED_THROW);
        }
        if (input.toolBridge?.tools?.['complete_thread']) {
          await input.toolBridge.tools['complete_thread']({
            summary: `built step ${input.stepId}`,
            verification: [
              { kind: 'test', command: 'pnpm test', exitCode: 0, outputTail: 'ok' },
            ],
          });
        }
        return {
          report: `did step ${input.stepId}`,
          session: {
            id: 'sess',
            jobId: input.jobId,
            stepId: input.stepId ?? null,
            engine: 'claude' as const,
            mode: input.mode as 'plan' | 'execute' | 'review',
            branch: 'b',
            worktreePath: '/wt/b',
          },
        };
      },
    ),
    canReattach: () => false,
  } as unknown as TurnRunnerService;
  return { turn, calls };
}

/** Canned collaborators for every OTHER `ThreadDriver` dependency — no docker/git/GitHub touched. Mirrors
 *  `thread-driver.service.spec.ts`'s `assemble()` fakes verbatim; only `store` is REAL (live Postgres). */
function makeGit(): { git: LocalGitService } {
  const git = {
    createFeatureSandbox: vi.fn(async (_repo: ProjectRepo, branch: string): Promise<FeatureSandbox> => ({
      repoId: REPO.repoId,
      branch,
      worktreePath: `/wt/${branch}`,
      gitUrl: REPO.gitUrl,
      token: 'ghtok',
    })),
    headSha: vi.fn(async () => 'sha0'),
    currentBranch: vi.fn(async () => null),
    hasChanges: vi.fn(async () => false),
    push: vi.fn(async () => undefined),
    changedFileNames: vi.fn(async () => [] as string[]),
    scanBranchForForbidden: vi.fn(async () => [] as string[]),
  } as unknown as LocalGitService;
  return { git };
}

function makePr(): { pr: GithubPrService } {
  const pr = {
    openPullRequest: vi.fn(async (_token: string, args: { head: string }) => ({
      url: 'https://github.com/acme/stream-closed/pull/1',
      number: 1,
      existing: false,
    })),
    findOpenPullByHead: vi.fn(async (_token: string, args: { head: string }) => ({
      url: 'https://github.com/acme/stream-closed/pull/1',
      number: 1,
      head: args.head,
    })),
  } as unknown as GithubPrService;
  return { pr };
}

describe('ThreadDriver — the lane RE-DRIVES on the stream-closed circuit-breaker throw (live Postgres)', () => {
  let mod: TestingModule;
  let store: DriverStoreService;
  let ds: DataSource;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
  let records: Repository<DecisionRecordEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        DriverStoreService,
        { provide: JobDependencyService, useValue: { blockersOf: async () => [] } },
      ],
    }).compile();
    // `Test.createTestingModule(...).compile()` globally silences Nest's `Logger` (routes every
    // instance through `TestingLogger`, which no-ops log/warn/debug — see
    // `@nestjs/testing/services/testing-logger.service.js`). Restore a real console logger so the
    // driver's OWN `this.logger.warn(...)` retry line (asserted/captured below) actually prints —
    // this is a global static override, so it also re-enables it for the driver instantiated below.
    Logger.overrideLogger(new ConsoleLogger());

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    records = mod.get(getRepositoryToken(DecisionRecordEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Stream Closed Org', 'stream-closed-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'stream-closed-repo', 'Stream Closed Repo', $2, 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, REPO.gitUrl],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  it(
    'boots the real ThreadDriver + real DriverStoreService over LIVE Postgres rows; the fake engine throws ' +
      'the wrapped circuit-breaker message on turn 1; the driver classifies it TRANSIENT and re-drives a ' +
      'fresh turn (turn 2) that completes — the job reaches `done` in Postgres, never `failed`',
    async () => {
      // ── seed a real job + decision record + builder thread ─────────────────────────────────────────
      const job = await jobs.save(
        jobs.create({
          org_id: ORG_ID,
          repo_id: repoId,
          origin: 'control',
          title: 'Stream-closed self-heal',
          kind: 'feature',
          build_path: 'plan',
          status: 'running',
          activity: 'idle',
          base_branch: 'main',
        }),
      );
      const [record] = await records.save([
        records.create({
          org_id: ORG_ID,
          repo_id: repoId,
          job_id: job.id,
          status: 'approved',
          overview: 'Prove the stream-closed circuit-breaker throw self-heals.',
          decisions: [],
          thread_titles: ['Backend'],
          approved_at: new Date(),
        }),
      ]);
      await jobs.update({ id: job.id }, { decision_record_id: record.id });
      await threads.save(
        threads.create({
          job_id: job.id,
          org_id: ORG_ID,
          kind: 'builder',
          ordinal: 10,
          brief: 'Backend — stream-closed self-heal',
          status: 'pending',
          condition: 'none',
          decision_record_id: record.id,
        }),
      );

      // ── assemble the real driver ────────────────────────────────────────────────────────────────────
      const { turn, calls } = makeStreamClosedTurn();
      const { git } = makeGit();
      const { pr } = makePr();
      const env = {
        get: (k: string) => (k === 'DRIVER_TRANSIENT_RETRY_MS' ? '1' : undefined),
      } as unknown as EnvService;
      const liveTurns = {
        push: vi.fn(),
        end: vi.fn(),
        snapshot: vi.fn(() => null),
        retry: vi.fn(),
      } as unknown as LiveTurnStore;
      const blockSink = {
        appendBlock: vi.fn(async () => undefined),
        appendBlockOnce: vi.fn(async () => undefined),
      } as unknown as BlockSink;
      const taskSink = { applyTaskEvent: vi.fn(async () => undefined) } as unknown as TaskEventSink;
      const usage = {
        getResetAt: () => undefined,
        applyHarvest: vi.fn().mockResolvedValue(undefined),
      } as unknown as OauthUsageService;
      const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, taskSink, usage);
      const brainGateway = {
        openPrAtShip: vi.fn(async () => undefined),
        notifyThreadHalted: vi.fn(async () => undefined),
        notifyThreadDone: vi.fn(async () => undefined),
      } as unknown as import('../brain-gateway').BrainGateway;
      let judgeCalls = 0;
      const judge = {
        async judge() {
          judgeCalls++;
          return { runtimeSurfaceTouched: false, liveVerificationAdequate: true, reason: 'test verdict' };
        },
      } as unknown as LiveVerificationJudge;
      let staticJudgeCalls = 0;
      const staticJudge = {
        async judge() {
          staticJudgeCalls++;
          return { staticChecksAdequate: true, reason: 'test verdict' };
        },
      } as unknown as StaticVerificationJudge;
      const electionState = { draining: false, leader: true };

      const driver = new ThreadDriver(
        store,
        { resolve: async () => RESOLVED } as unknown as DriverRepoResolver,
        git,
        pr,
        turn,
        { postSectionPlan: vi.fn(async () => 'vis-ts') } as unknown as PlanVisibilityService,
        {
          autofixThread: vi.fn(),
          autofixPullRequest: vi.fn(),
          runReviewLens: vi.fn(async () => []),
          applyReviewFindings: vi.fn(async () => ({ fixReport: '', commits: [] })),
          ensureContextDiff: vi.fn(async (ctx: Record<string, unknown>) => ({ ...ctx, diff: 'x', changedFiles: ['f.ts'] })),
          emitReviewNotice: vi.fn(async () => undefined),
        } as unknown as AutoFixStage,
        { name: 'agent', post: vi.fn(async () => 'ts') } as unknown as ChatSurface,
        env,
        {
          attach: async ({ sandbox }: { sandbox: FeatureSandbox }) => sandbox,
          teardown: async () => undefined,
          teardownByIdentity: async () => undefined,
          contextDirHost: () => '/ctx',
          playgroundDirHost: () => '/playground',
          brainTranscriptProjectsDir: () => null,
          supervisorDirHost: () => null,
          probeLiveness: async () => ({ status: 'unknown' as const }),
          stopAllServices: vi.fn().mockResolvedValue({ ok: true }),
          sandboxContainerName: () => 'atlas-sbx-stream-closed-test',
          bridgeCaddyToSandbox: async () => undefined,
          unbridgeCaddyFromSandbox: async () => undefined,
          listLiveThreadJobIds: async () => [],
        } as never,
        {
          anthropicKey: async () => undefined,
          openaiKey: async () => undefined,
          githubToken: async () => undefined,
          githubWriteIdentity: async () => ({}),
          engineAuth: async () => ({ secret: 'test-secret' }),
        } as unknown as CredentialResolver,
        usage,
        { resolveForTurn: async () => [], resolveForSandbox: async () => [] } as never,
        { refreshForSandbox: async () => ({ rotated: false }) } as never,
        { resolveForTurn: async () => [], resolveReviewSkillsForThread: async () => [] } as never,
        {
          ensureContainer: async () => ({
            sandbox: {
              repoId: REPO.repoId,
              branch: 'atlas/feature-stream-closed',
              worktreePath: '/wt/atlas/feature-stream-closed',
              gitUrl: REPO.gitUrl,
              token: 'ghtok',
            },
            wasReset: false,
          }),
          findSandbox: async () => null,
          recordPr: async () => undefined,
          contextDirHost: () => '/ctx',
          supervisorDirHost: () => null,
        } as unknown as import('./job-lifecycle.service').JobLifecycleService,
        new BuildShipService(git, pr, store, brainGateway),
        {
          maybeAutoMerge: async () => undefined,
          mergeNow: async () => false,
        } as unknown as import('./auto-merge.service').AutoMergeService,
        {
          appendMarker: async () => undefined,
          drainAndAdvance: async () => ({ markers: [], stateChanged: false }),
        } as unknown as import('./pipeline-awareness.store').PipelineAwarenessStore,
        {
          isDraining: () => electionState.draining,
          isLeader: () => electionState.leader && !electionState.draining,
        } as unknown as LeaderElectionService,
        turnHarness,
        blockSink,
        liveTurns,
        { listRunning: async () => [] } as unknown as import('../sandbox/turn-registry.service').TurnRegistry,
        brainGateway,
        judge,
        staticJudge,
        taskSink,
        undefined,
        undefined,
        undefined,
      );

      // Spy on the REAL store's setJobHalt so we can assert a `failed` halt was NEVER stamped, while the
      // real Postgres write still goes through (no mockImplementation override — call-through). Job failure
      // is signaled via `JobHalt.kind === 'failed'`, not the `JobStatus` phase.
      const setJobHaltSpy = vi.spyOn(store, 'setJobHalt');

      // ── drive it ─────────────────────────────────────────────────────────────────────────────────────
      const domainJob = await store.loadJob(job.id);
      await driver.dispatch(domainJob);

      // Poll the LIVE `jobs` row for the terminal state; auto-click "Ship it" the instant the ship-review
      // gate parks (mirrors `assemble()`'s `autoShipApprove` default), driven off REAL DB reads throughout.
      const deadline = Date.now() + 60_000;
      let shipApproved = false;
      let finalStatus = '';
      while (Date.now() < deadline) {
        const row = await jobs.findOneOrFail({ where: { id: job.id } });
        finalStatus = row.status;
        if (row.status === 'done' || row.status === 'failed') break;
        if (row.status === 'awaiting_ship_review' && !shipApproved) {
          shipApproved = true;
          await driver.resolveShipApprovalDurably(job.id, 'auto-test');
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      // ── assertions — the lane SELF-HEALED, read back from live Postgres ────────────────────────────────
      expect(finalStatus).toBe('done');

      const execCalls = calls.filter((c) => c.mode === 'execute');
      expect(execCalls.length).toBeGreaterThanOrEqual(2); // turn 1 (stream-closed throw) + turn 2 (fresh, completed)

      // Never stamped a `failed` halt at any point in the drive.
      expect(
        setJobHaltSpy.mock.calls.some((c) => c[1]?.kind === 'failed'),
      ).toBe(false);

      const finalRow = await jobs.findOneOrFail({ where: { id: job.id } });
      expect(finalRow.status).toBe('done');
      expect(finalRow.halt).toBeNull();
      expect(finalRow.pr_url).toBeTruthy();

      const threadRow = await threads.findOneOrFail({ where: { job_id: job.id, kind: 'builder' } });
      expect(threadRow.status).toBe('done');
    },
    90_000,
  );
});
