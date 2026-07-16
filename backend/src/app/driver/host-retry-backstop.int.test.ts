/**
 * Live-infra proof for the build-lane HOST BACKSTOP (`runJobWithTransientRetry`, `thread-driver.service.ts`
 * ~885-919): when a build turn throws a transient host-transport/infra error (matching
 * `HOST_TRANSPORT_TRANSIENT_RE`), the driver retries the SAME job on a FRESH turn up to `MAX_HOST_RETRIES`
 * (10) at a fixed `HOST_RETRY_BACKOFF_MS` (10s) backoff, and on EACH attempt (a) posts a durable quiet
 * `system_notice` block via `relayRetrying` and (b) fans a best-effort live `turn_retry` indicator via
 * `LiveTurnStore.retry(...)`.
 *
 * This test boots the REAL `ThreadDriver` + the REAL `DriverStoreService` against LIVE Postgres (every
 * job/thread/message row below is a genuine TypeORM write/read), with a FAKE `TurnRunnerService` standing in
 * for the engine seam (throws a transient transport error 3 times, then completes) — mirroring
 * `stream-closed-recovery.int.test.ts`'s structure. Unlike that sibling test, THIS one also wires the REAL
 * `MessageBlockSink` (over the live `messages` table) and the REAL `LiveTurnStore` in place of fakes, so it
 * proves the retry notice actually lands in Postgres and the retry indicator actually fans on the real RxJS
 * subject — not just that fake spies were called.
 */
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  ENTITIES,
  JobEntity,
  ThreadEntity,
  DecisionRecordEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { JobDependencyService } from '../job-deps';
import { DriverStoreService } from './driver-store.service';
import { ThreadDriver } from './thread-driver.service';
import { BuildShipService } from './build-ship.service';
import type { DriverRepoResolver, ResolvedRepo } from './repo-resolver';
import type { PlanVisibilityService } from '../decision-gate';
import type { AutoFixStage } from '../autofix';
import type {
  GithubPrService,
  LocalGitService,
  FeatureSandbox,
  ProjectRepo,
} from '../git';
import type { TurnRunnerService } from '../runner';
import type { ChatSurface, TaskEventSink } from '../surface';
import {
  LiveTurnStore,
  MessageBlockSink,
  TurnHarnessFactory,
} from '../surface';
import type { AppVersionService } from '../cluster/app-version.service';
import type { ToolBridgeOptions } from '@shared/engine';
import { HOST_RETRY_BACKOFF_MS, MAX_HOST_RETRIES } from '@shared/engine';
import type { CredentialResolver } from '../onboarding';
import type { OauthUsageService } from '../onboarding/oauth-usage.service';
import type { LeaderElectionService } from '../cluster';

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
    // Deliberately NOT 10_000: this test clamps every `setTimeout(..., HOST_RETRY_BACKOFF_MS)` (10_000) call
    // to 0ms for speed (see `clampHostRetryBackoff`) — a colliding connectTimeoutMS would get clamped too and
    // make pg's own connection-timeout timer fire instantly.
    connectTimeoutMS: 20_000,
    ssl: false as const,
  };
}

const ORG_ID = '32222222-2222-4222-8222-222222222222';
const REPO: ProjectRepo = {
  repoId: 'host-retry-backstop-proj',
  gitUrl: 'https://github.com/acme/host-retry-backstop',
  defaultBranch: 'main',
  repoPath: '/repos/host-retry-backstop-proj',
};
const RESOLVED: ResolvedRepo = {
  projectRepo: REPO,
  owner: 'acme',
  repo: 'host-retry-backstop',
  defaultBranch: 'main',
  token: 'ghtok',
};

/** A transient host-transport error — matches `HOST_TRANSPORT_TRANSIENT_RE` ("connection reset", "exec
 *  failed") — the exact shape a sandbox exec hiccup produces. */
const TRANSIENT_THROW = 'sandbox exec failed: connection reset by peer';

/** A fake `TurnRunnerService`: throws the transient transport error on the first `remainingFailures` calls,
 *  then completes the thread cleanly via `complete_thread` on the next (fresh) turn. */
function makeTransientTurn(remainingFailuresAtStart: number): {
  turn: TurnRunnerService;
  calls: Array<{ mode: string; stepId?: string | null }>;
} {
  let remainingFailures = remainingFailuresAtStart;
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
          throw new Error(TRANSIENT_THROW);
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

/** Canned collaborators for every OTHER `ThreadDriver` dependency — no docker/git/GitHub touched. Mirrors
 *  `stream-closed-recovery.int.test.ts`'s fakes; only `store`, the block sink, and the live-turn store are
 *  REAL (live Postgres + the real in-memory RxJS subject). */
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
      url: 'https://github.com/acme/host-retry-backstop/pull/1',
      number: 1,
      existing: false,
    })),
    findOpenPullByHead: vi.fn(
      async (_token: string, args: { head: string }) => ({
        url: 'https://github.com/acme/host-retry-backstop/pull/1',
        number: 1,
        head: args.head,
      }),
    ),
  } as unknown as GithubPrService;
  return { pr };
}

/** Run `fn` with ONLY the fixed `HOST_RETRY_BACKOFF_MS` host-retry backoff collapsed to 0ms, on REAL timers
 *  — everything else keeps its true duration. Modeled on `thread-driver.service.spec.ts`'s
 *  `withInstantHostRetryBackoff`; a 3-retry drive at the real 10s backoff would otherwise burn ~30s. */
function clampHostRetryBackoff(): { restore: () => void } {
  const realSetTimeout = globalThis.setTimeout;
  const spy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation(((
      cb: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) =>
      realSetTimeout(
        cb,
        delay === HOST_RETRY_BACKOFF_MS ? 0 : delay,
        ...args,
      )) as unknown as typeof setTimeout);
  return { restore: () => spy.mockRestore() };
}

describe('ThreadDriver — the host backstop RETRIES a transient drive error over LIVE Postgres, posting a durable notice + live indicator each attempt', () => {
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
        {
          provide: JobDependencyService,
          useValue: { blockersOf: async () => [] },
        },
      ],
    }).compile();
    // See `stream-closed-recovery.int.test.ts` — `.compile()` silences Nest's `Logger`; restore a real one so
    // the driver's own `this.logger.warn(...)` retry line prints in the run log.
    Logger.overrideLogger(new ConsoleLogger());

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));
    records = mod.get(getRepositoryToken(DecisionRecordEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Host Retry Backstop Org', 'host-retry-backstop-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'host-retry-backstop-repo', 'Host Retry Backstop Repo', $2, 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, REPO.gitUrl],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  it(
    'boots the real ThreadDriver + real DriverStoreService + real MessageBlockSink + real LiveTurnStore over ' +
      'LIVE Postgres; the fake engine throws a transient transport error 3 times, then completes on the 4th ' +
      'turn — the job reaches `done`, and Postgres + the live store both carry 3 auto-retry notices/frames',
    async () => {
      // ── seed a real job + decision record + builder thread ─────────────────────────────────────────
      const job = await jobs.save(
        jobs.create({
          org_id: ORG_ID,
          repo_id: repoId,
          origin: 'control',
          title: 'Host retry backstop',
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
          overview:
            'Prove the host backstop self-heals a 3x transient error and instruments both retry channels.',
          decisions: [],
          thread_titles: ['Backend'],
          approved_at: new Date(),
        }),
      ]);
      await jobs.update({ id: job.id }, { decision_record_id: record.id });
      // Every job carries one planning thread group at job start — the anchor job-level operator notices are
      // stamped onto (messages.thread_id is NOT NULL). The driver never executes it; it's render-only.
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
        brief: 'Backend — host retry backstop',
      });

      // ── assemble the real driver ────────────────────────────────────────────────────────────────────
      const { turn, calls } = makeTransientTurn(3);
      const { git } = makeGit();
      const { pr } = makePr();
      const env = {
        get: (k: string) =>
          k === 'DRIVER_TRANSIENT_RETRY_MS' ? '1' : undefined,
      } as unknown as EnvService;
      // REAL live-turn store — the actual RxJS subject the retry loop fans `turn_retry` frames onto.
      const liveTurns = new LiveTurnStore();
      const retryFrames: Array<{
        lane: string;
        attempt: number;
        max: number;
        [k: string]: unknown;
      }> = [];
      const liveTurnsSub = liveTurns.stream$.subscribe((f) => {
        const event = f.event as {
          kind?: string;
          attempt: number;
          max: number;
          [k: string]: unknown;
        };
        if (event.kind === 'turn_retry') {
          retryFrames.push({ lane: f.lane, ...event });
        }
      });
      // REAL block sink — the actual `TranscriptMessageEntity` repository, so the durable retry notice lands in
      // live Postgres `messages`.
      const version = { sha: 'dev' } as unknown as AppVersionService;
      const blockSink = new MessageBlockSink(
        mod.get(getRepositoryToken(TranscriptMessageEntity, DB_CONNECTION)),
        version,
      );
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
          sandboxContainerName: () => 'atlas-sbx-host-retry-backstop-test',
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
              branch: 'atlas/feature-host-retry-backstop',
              worktreePath: '/wt/atlas/feature-host-retry-backstop',
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
        {
          listRunning: async () => [],
        } as unknown as import('../sandbox/turn-registry.service').TurnRegistry,
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
        } as unknown as import('../job-bootstrap').JobBootstrapService,
      );

      // Spy on the REAL store's setJobHalt (call-through, real Postgres write still goes through) so we can
      // assert a `failed` halt was NEVER stamped during the drive.
      const setJobHaltSpy = vi.spyOn(store, 'setJobHalt');

      // ── drive it, with ONLY the fixed host-retry backoff collapsed to 0ms ───────────────────────────────
      const domainJob = await store.loadJob(job.id);
      const clamp = clampHostRetryBackoff();
      let finalStatus = '';
      try {
        await driver.dispatch(domainJob);

        // Poll the LIVE `jobs` row for the terminal state; auto-click "Ship it" the instant the ship-review
        // gate parks, driven off REAL DB reads throughout.
        const deadline = Date.now() + 60_000;
        let shipApproved = false;
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
      } finally {
        clamp.restore();
      }
      liveTurnsSub.unsubscribe();

      // ── assertions — the lane SELF-HEALED, read back from live Postgres + the live store ───────────────
      expect(finalStatus).toBe('done');

      const execCalls = calls.filter((c) => c.mode === 'execute');
      expect(execCalls.length).toBeGreaterThanOrEqual(4); // 3 transient throws + 1 fresh completing turn

      expect(
        setJobHaltSpy.mock.calls.some((c) => c[1]?.kind === 'failed'),
      ).toBe(false);

      const finalRow = await jobs.findOneOrFail({ where: { id: job.id } });
      expect(finalRow.status).toBe('done');
      expect(finalRow.halt).toBeNull();
      expect(finalRow.pr_url).toBeTruthy();

      const threadRow = await threads.findOneOrFail({
        where: { job_id: job.id, role: 'builder' },
      });
      expect(threadRow.status).toBe('done');

      // The durable quiet `system_notice` rows — the real backstop deliverable, read back from Postgres.
      const noticeRows: Array<{ text: string }> = await ds.query(
        `SELECT text FROM transcript_messages WHERE job_id = $1 AND meta->>'source' = 'system_notice' ORDER BY created_at`,
        [job.id],
      );
      expect(noticeRows.length).toBeGreaterThanOrEqual(3);
      const noticeTexts = noticeRows.map((r) => r.text);
      expect(
        noticeTexts.some((t) => t.includes(`auto-retry 1/${MAX_HOST_RETRIES}`)),
      ).toBe(true);
      expect(
        noticeTexts.some((t) => t.includes(`auto-retry 2/${MAX_HOST_RETRIES}`)),
      ).toBe(true);
      expect(
        noticeTexts.some((t) => t.includes(`auto-retry 3/${MAX_HOST_RETRIES}`)),
      ).toBe(true);

      // The best-effort live `turn_retry` indicator — fanned on the REAL `LiveTurnStore` subject.
      expect(retryFrames.length).toBeGreaterThanOrEqual(3);
      expect(retryFrames.slice(0, 3).map((f) => f.attempt)).toEqual([1, 2, 3]);
      expect(retryFrames.every((f) => f.max === MAX_HOST_RETRIES)).toBe(true);
      expect(
        retryFrames
          .slice(0, 3)
          .every((f) => f.lane === `thread:${threadRow.id}`),
      ).toBe(true);

      console.log(
        'OBSERVED system_notice texts (live Postgres `messages`):',
        noticeTexts,
      );

      console.log(
        'OBSERVED turn_retry frames (live LiveTurnStore.stream$):',
        retryFrames,
      );
    },
    90_000,
  );
});
