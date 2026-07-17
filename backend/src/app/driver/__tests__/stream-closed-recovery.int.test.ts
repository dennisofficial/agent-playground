import type { EnvService } from '@core/config/env/env.service';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { ToolBridgeOptions } from '@shared/engine';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import type { FeatureSandbox, GithubPrService, LocalGitService, ProjectRepo } from '../../git';
import { JobDependencyService } from '../../job-deps';
import type { CredentialResolver } from '../../onboarding';
import type { OauthUsageService } from '../../onboarding/oauth-usage.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import {
  DecisionRecordEntity,
  ENTITIES,
  JobEntity,
  ThreadEntity,
} from '../../persistence/entities';
import type { TurnRunnerService } from '../../runner';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import type { BlockSink, ChatSurface, LiveTurnStore, TaskEventSink } from '../../surface';
import { TurnHarnessFactory } from '../../surface';
import type { AutoFixStage } from '../autofix';
import { BuildShipService } from '../build-ship.service';
import type { LeaderElectionService } from '../cluster/leader-election.service';
import type { PlanVisibilityService } from '../decision-gate';
import { DriverStoreService } from '../driver-store.service';
import type { ResolvedRepo } from '../repo-resolver';
import { ThreadDriver } from '../thread-driver.service';

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

const STREAM_CLOSED_THROW =
  'in-sandbox engine turn failed: Error: engine stream closed: control channel severed mid-turn (circuit-breaker)';

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
          throw new Error(STREAM_CLOSED_THROW);
        }
        if (input.toolBridge?.tools?.['complete_thread']) {
          await input.toolBridge.tools['complete_thread']({
            summary: `built step ${input.stepId}`,
            verification: [
              {
                kind: 'test',
                command: 'pnpm test',
                exitCode: 0,
                outputTail: 'ok',
              },
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

function makeGit(): { git: LocalGitService } {
  const git = {
    createFeatureSandbox: vi.fn(
      async (_repo: ProjectRepo, branch: string): Promise<FeatureSandbox> => ({
        repoId: REPO.repoId,
        branch,
        worktreePath: `/wt/${branch}`,
        gitUrl: REPO.gitUrl,
        token: 'ghtok',
      }),
    ),
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
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [
        DriverStoreService,
        {
          provide: JobDependencyService,
          useValue: { blockersOf: async () => [] },
        },
        {
          provide: StimulusStoreService,
          useValue: { pendingBlockedPreview: async () => null },
        },
      ],
    }).compile();
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
      const planningThreadGroup = await store.createThreadGroup({
        jobId: job.id,
        orgId: ORG_ID,
        kind: 'planning',
        title: 'Planning',
      });
      await store.createThreadInThreadGroup({
        threadGroupId: planningThreadGroup.id,
        jobId: job.id,
        orgId: ORG_ID,
        role: 'planning',
        ordinal: 0,
        brief: 'Main',
      });
      const threadGroup = await store.createThreadGroup({
        jobId: job.id,
        orgId: ORG_ID,
        kind: 'build',
        title: 'Backend',
        decisionRecordId: record.id,
      });
      await store.createThreadInThreadGroup({
        threadGroupId: threadGroup.id,
        jobId: job.id,
        orgId: ORG_ID,
        role: 'builder',
        ordinal: 10,
        brief: 'Backend — stream-closed self-heal',
      });

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
      const taskSink = {
        createTask: vi.fn(async () => ({ id: 'noop' })),
        updateTask: vi.fn(async () => ({ ok: true })),
        readTasks: vi.fn(async () => []),
      } as unknown as TaskEventSink;
      const usage = {
        getResetAt: () => undefined,
        applyHarvest: vi.fn().mockResolvedValue(undefined),
      } as unknown as OauthUsageService;
      const turnHarness = new TurnHarnessFactory(liveTurns, blockSink, usage);
      const brainGateway = {
        openPrAtShip: vi.fn(async () => undefined),
        notifyThreadHalted: vi.fn(async () => undefined),
        notifyThreadDone: vi.fn(async () => undefined),
        seedPostBuildGate: vi.fn(async () => undefined),
      } as unknown as import('../brain-gateway').BrainGateway;
      const electionState = { draining: false, leader: true };

      const driver = new ThreadDriver(
        store,
        { resolve: async () => RESOLVED },
        git,
        pr,
        turn,
        {
          postSectionPlan: vi.fn(async () => 'vis-ts'),
        } as unknown as PlanVisibilityService,
        {
          autofixThread: vi.fn(),
          autofixPullRequest: vi.fn(),
          runReviewLens: vi.fn(async () => []),
          applyReviewFindings: vi.fn(async () => ({
            fixReport: '',
            commits: [],
          })),
          ensureContextDiff: vi.fn(async (ctx: Record<string, unknown>) => ({
            ...ctx,
            diff: 'x',
            changedFiles: ['f.ts'],
          })),
          emitReviewNotice: vi.fn(async () => undefined),
        } as unknown as AutoFixStage,
        {
          name: 'agent',
          post: vi.fn(async () => 'ts'),
        } as unknown as ChatSurface,
        env,
        {
          attach: async ({ sandbox }: { sandbox: FeatureSandbox }) => sandbox,
          teardown: async () => undefined,
          teardownByIdentity: async () => undefined,
          contextDirHost: () => '/ctx',
          playgroundDirHost: () => '/playground',
          draftUploadsDirHost: () => '/draft-uploads',
          brainTranscriptProjectsDir: () => null,
          supervisorDirHost: () => null,
          probeLiveness: async () => ({ status: 'unknown' as const }),
          stopAllServices: vi.fn().mockResolvedValue({ ok: true }),
          sandboxContainerName: () => 'atlas-sbx-stream-closed-test',
          bridgeCaddyToSandbox: async () => undefined,
          unbridgeCaddyFromSandbox: async () => undefined,
          listLiveThreadJobIds: async () => [],
        },
        {
          anthropicKey: async () => undefined,
          openaiKey: async () => undefined,
          githubToken: async () => undefined,
          githubWriteIdentity: async () => ({}),
          engineAuth: async () => ({ secret: 'test-secret' }),
        } as unknown as CredentialResolver,
        usage,
        {
          resolveForTurn: async () => [],
          resolveForSandbox: async () => [],
        } as never,
        { refreshForSandbox: async () => ({ rotated: false }) } as never,
        {
          resolveForTurn: async () => [],
          resolveReviewSkillsForThread: async () => [],
        } as never,
        { select: async () => [] } as never,
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
        } as unknown as import('../job-lifecycle.service').JobLifecycleService,
        new BuildShipService(git, pr, store, brainGateway),
        {
          maybeAutoMerge: async () => undefined,
          mergeNow: async () => false,
        } as unknown as import('../auto-merge.service').AutoMergeService,
        {
          appendMarker: async () => undefined,
          drainAndAdvance: async () => ({ markers: [], stateChanged: false }),
        } as unknown as import('../pipeline-awareness.store').PipelineAwarenessStore,
        {
          isDraining: () => electionState.draining,
          isLeader: () => electionState.leader && !electionState.draining,
        } as unknown as LeaderElectionService,
        turnHarness,
        blockSink,
        liveTurns,
        {
          listRunning: async () => [],
        } as unknown as import('../../sandbox/turn-registry.service').TurnRegistry,
        brainGateway,
        taskSink,
        undefined, // exposure
        undefined, // conventions
        undefined, // claudeCreds
        undefined, // configStore
        undefined, // stimulusStore
        undefined, // jit
        {
          planningThreadId: async (jid: string) =>
            (
              await threads.findOneOrFail({
                where: { job_id: jid, role: 'planning' },
              })
            ).id,
        } as unknown as import('../../job-bootstrap').JobBootstrapService,
      );

      const setJobHaltSpy = vi.spyOn(store, 'setJobHalt');

      const domainJob = await store.loadJob(job.id);
      await driver.dispatch(domainJob);

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

      expect(finalStatus).toBe('done');

      const execCalls = calls.filter((c) => c.mode === 'execute');
      expect(execCalls.length).toBeGreaterThanOrEqual(2); // turn 1 (stream-closed throw) + turn 2 (fresh, completed)

      expect(setJobHaltSpy.mock.calls.some((c) => c[1]?.kind === 'failed')).toBe(false);

      const finalRow = await jobs.findOneOrFail({ where: { id: job.id } });
      expect(finalRow.status).toBe('done');
      expect(finalRow.halt).toBeNull();
      expect(finalRow.pr_url).toBeTruthy();

      const threadRow = await threads.findOneOrFail({
        where: { job_id: job.id, role: 'builder' },
      });
      expect(threadRow.status).toBe('done');
    },
    90_000,
  );
});
