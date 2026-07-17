/**
 * Task 6 — the thread-group-driven pipeline PROOF (live Postgres, stubbed engine).
 *
 * Boots the REAL {@link ThreadDriver} + REAL {@link DriverStoreService} + REAL {@link BuildShipService}
 * against LIVE Postgres, with a FAKE {@link TurnRunnerService} standing in for the whole engine seam (NO
 * real Claude/Codex SDK traffic — the fake scripts every outcome by calling the host tool bridge:
 * `complete_thread` / `record_leg_handoff` / `block_thread`). Mirrors the construction of
 * `driver/host-retry-backstop.int.test.ts` (same canned collaborators, same real store), and seeds the
 * fixture plan through the store's OWN thread-group/thread CRUD (`createThreadGroup` / `createThreadInThreadGroup`) exactly
 * like `driver/driver-store.int.test.ts` — the driver now iterates THREAD GROUPS, so a bare-thread seed no longer
 * drives.
 *
 * Two drives under one describe:
 *  - HAPPY PATH (one continuous drive): asserts the fixture thread groups exist in the right kind/order
 *    (planning / plan_review / build×2 / master_review), that a builder `record_leg_handoff` inserts a
 *    SECOND builder into the SAME thread group sharing the thread group's `tasks` checklist (2a), that review_agent +
 *    review_fix threads are thread-group-scoped children of the LAST builder run ONCE over the thread group diff (2b),
 *    that the ship-review GATE (posted right after master review) spawns a `post_build` thread-group thread (2d),
 *    and that `ship()` spawns a `ci` thread-group thread and `BrainGateway.openPrAtShip` fires with THAT (ci)
 *    thread's id — PR creation lives on `ci`, not `post_build` (2e).
 *  - HALT PATH (separate drive): a `block_thread` halt leaves the thread `blocked`/paused, stops the job
 *    driving (no ship, no PR), and NEVER calls `BrainGateway` — proving the headless driver property (2c).
 */
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
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { EnvService } from '@core/config/env/env.service';
import { CustomNamingStrategy } from '../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from './persistence/database.module';
import { ENTITIES, JobEntity, ThreadEntity } from './persistence/entities';
import { JobDependencyService } from './job-deps';
import { DriverStoreService } from './driver/driver-store.service';
import { ThreadDriver } from './driver/thread-driver.service';
import { BuildShipService } from './driver/build-ship.service';
import type { DriverRepoResolver, ResolvedRepo } from './driver/repo-resolver';
import type { PlanVisibilityService } from './decision-gate';
import type { AutoFixStage } from './autofix';
import type {
  GithubPrService,
  LocalGitService,
  FeatureSandbox,
  ProjectRepo,
} from './git';
import type { TurnRunnerService } from './runner';
import type {
  BlockSink,
  ChatSurface,
  LiveTurnStore,
  TaskEventSink,
} from './surface';
import { TurnHarnessFactory } from './surface';
import type { ToolBridgeOptions } from '@shared/engine';
import type { CredentialResolver } from './onboarding';
import type { OauthUsageService } from './onboarding/oauth-usage.service';
import type { LeaderElectionService } from './cluster';
import type { BrainGateway } from './brain-gateway';

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

const ORG_ID = '4a111111-1111-4111-8111-111111111111';
const AUTO_APPROVER = '4a222222-2222-4222-8222-222222222222';
const REPO: ProjectRepo = {
  repoId: 'pipeline-int-proj',
  gitUrl: 'https://github.com/acme/pipeline-int',
  defaultBranch: 'main',
  repoPath: '/repos/pipeline-int-proj',
};
const RESOLVED: ResolvedRepo = {
  projectRepo: REPO,
  owner: 'acme',
  repo: 'pipeline-int',
  defaultBranch: 'main',
  token: 'ghtok',
};

/** How the fake engine should terminate a given thread's turn — keyed by the thread id the driver passes as
 *  `input.stepId` (a thread's synthetic step id IS its own id). Anything not listed completes cleanly. */
type ThreadScript = { rotateThreadId?: string; incompleteThreadId?: string };

/**
 * A FAKE {@link TurnRunnerService}: no real engine. For each `runTurn`, it looks up the running thread
 * (`input.stepId`) in the script and drives the host tool bridge to the desired terminal outcome:
 *  - `rotateThreadId` → calls `record_leg_handoff` (no `complete_thread`): the driver rotates in a fresh
 *    builder leg.
 *  - `incompleteThreadId` → ends the turn WITHOUT `complete_thread`: the thread lands in the single "not
 *    done" state (`condition='incomplete'`), the driver halts the job for the operator.
 *  - otherwise → calls `complete_thread` (retrying once past the one-shot open-task nudge).
 */
function makeFakeTurn(script: ThreadScript): {
  turn: TurnRunnerService;
  calls: Array<{ mode: string; stepId?: string | null }>;
} {
  const calls: Array<{ mode: string; stepId?: string | null }> = [];
  const verification = [
    { kind: 'test', command: 'pnpm test', exitCode: 0, outputTail: 'ok' },
  ];
  const turn = {
    runTurn: vi.fn(
      async (input: {
        mode: string;
        stepId?: string | null;
        jobId: string;
        toolBridge?: ToolBridgeOptions;
      }) => {
        calls.push({ mode: input.mode, stepId: input.stepId });
        const tools = input.toolBridge?.tools ?? {};
        const tid = input.stepId ?? '';
        if (script.incompleteThreadId && tid === script.incompleteThreadId) {
          // End the turn WITHOUT calling `complete_thread` — the single "not done" path.
        } else if (
          script.rotateThreadId &&
          tid === script.rotateThreadId &&
          tools['record_leg_handoff']
        ) {
          await tools['record_leg_handoff']({
            handoff:
              'Scope: wired the webhook handler (WIP).\nFAILED: `pnpm build` — return type mismatch.\nNext: finish the return type on the fresh leg.',
          });
        } else if (tools['complete_thread']) {
          // The first `complete_thread` with an open checklist is bounced ONCE (task nudge, returns a
          // `warning` without latching) so the model can reconcile its tasks in-turn; a real turn re-asserts.
          const first = (await tools['complete_thread']({
            summary: `built ${tid}`,
            verification,
          })) as { warning?: string } | undefined;
          if (first?.warning) {
            await tools['complete_thread']({
              summary: `built ${tid}`,
              verification,
            });
          }
        }
        return {
          report: `did ${tid}`,
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

/** Canned git — no real worktree touched. */
function makeGit(): LocalGitService {
  return {
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
}

/** Canned GitHub — discovery-by-head returns a PR so `latchPr` records it (→ setPrReady → ci seam). */
function makePr(): GithubPrService {
  return {
    openPullRequest: vi.fn(async () => ({
      url: 'https://github.com/acme/pipeline-int/pull/7',
      number: 7,
      existing: false,
    })),
    findOpenPullByHead: vi.fn(
      async (_token: string, args: { head: string }) => ({
        url: 'https://github.com/acme/pipeline-int/pull/7',
        number: 7,
        head: args.head,
      }),
    ),
  } as unknown as GithubPrService;
}

/** A `BrainGateway` whose live methods are spies — the whole point of the headless-driver assertion. */
function makeBrainGatewaySpy(): BrainGateway {
  return {
    openPrAtShip: vi.fn(async () => undefined),
    wakeUnblockedJob: vi.fn(async () => undefined),
    seedPostBuildGate: vi.fn(async () => undefined),
  } as unknown as BrainGateway;
}

describe('pipeline (live Postgres) — thread-group-driven drive over a stubbed engine', () => {
  let mod: TestingModule;
  let store: DriverStoreService;
  let ds: DataSource;
  let jobs: Repository<JobEntity>;
  let threads: Repository<ThreadEntity>;
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
    // `.compile()` silences Nest's Logger — restore a real one so the driver's own drive logs print.
    Logger.overrideLogger(new ConsoleLogger());

    store = mod.get(DriverStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    threads = mod.get(getRepositoryToken(ThreadEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Pipeline Int Org', 'pipeline-int-org'],
    );
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1, 'pipeline-int-approver@x.com', 'x', 'Pipeline Int Approver', 'operator')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [AUTO_APPROVER],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'pipeline-int-repo', 'Pipeline Int Repo', $2, 'main', NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, REPO.gitUrl],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query(
      'TRUNCATE tasks, threads, thread_groups, jobs RESTART IDENTITY CASCADE',
    );
  });

  /** Assemble the REAL driver with the canned collaborators + the given fake turn / brain-gateway spy —
   *  wiring copied verbatim from `driver/host-retry-backstop.int.test.ts` (the constructor is unchanged). */
  function makeDriver(
    turn: TurnRunnerService,
    brainGateway: BrainGateway,
  ): ThreadDriver {
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
    const electionState = { draining: false, leader: true };

    return new ThreadDriver(
      store,
      { resolve: async () => RESOLVED },
      makeGit(),
      makePr(),
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
        brainTranscriptProjectsDir: () => null,
        supervisorDirHost: () => null,
        probeLiveness: async () => ({ status: 'unknown' as const }),
        stopAllServices: vi.fn().mockResolvedValue({ ok: true }),
        sandboxContainerName: () => 'atlas-sbx-pipeline-int-test',
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
            branch: 'atlas/feature-pipeline-int',
            worktreePath: '/wt/atlas/feature-pipeline-int',
            gitUrl: REPO.gitUrl,
            token: 'ghtok',
          },
          wasReset: false,
        }),
        findSandbox: async () => null,
        recordPr: async () => undefined,
        contextDirHost: () => '/ctx',
        supervisorDirHost: () => null,
      } as unknown as import('./driver/job-lifecycle.service').JobLifecycleService,
      new BuildShipService(makeGit(), makePr(), store, brainGateway),
      {
        maybeAutoMerge: async () => undefined,
        mergeNow: async () => false,
      } as unknown as import('./driver/auto-merge.service').AutoMergeService,
      {
        isDraining: () => electionState.draining,
        isLeader: () => electionState.leader && !electionState.draining,
      } as unknown as LeaderElectionService,
      turnHarness,
      blockSink,
      liveTurns,
      {
        listRunning: async () => [],
      } as unknown as import('./sandbox/turn-registry.service').TurnRegistry,
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
      } as unknown as import('./job-bootstrap').JobBootstrapService,
    );
  }

  /** Seed a real job (feature, auto-approve ship inline) whose pipeline is the full ordinal-ordered plan:
   *  planning / plan_review / build "Backend" (+ a thread group task) / build "Frontend" / master_review. Root
   *  threads carry job-unique ordinals (the `(job_id, parent_thread_id, ordinal)` index is NULLS NOT
   *  DISTINCT, so two null-parent roots can't share an ordinal even across thread groups). */
  async function seedPlan(): Promise<{
    jobId: string;
    backendThreadGroupId: string;
    frontendThreadGroupId: string;
    masterThreadGroupId: string;
    backendBuilderId: string;
    frontendBuilderId: string;
    taskId: string;
    taskOrdinalId: string;
  }> {
    const job = await jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'control',
        title: 'Pipeline int fixture',
        kind: 'feature',
        build_path: 'plan',
        status: 'building',
        base_branch: 'main',
        auto_approve_mode: 'both',
        auto_approve_by: AUTO_APPROVER,
      }),
    );

    const planning = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'planning',
      title: 'Plan',
    });
    await store.createThreadInThreadGroup({
      threadGroupId: planning.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'planning',
      brief: 'Main',
      ordinal: 100,
    });
    const planReview = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'plan_review',
    });
    await store.createThreadInThreadGroup({
      threadGroupId: planReview.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'plan_review',
      brief: 'Plan review',
      ordinal: 200,
    });

    const backend = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Backend',
    });
    const backendBuilder = await store.createThreadInThreadGroup({
      threadGroupId: backend.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Backend — wire the handler',
      ordinal: 300,
    });
    const task = await store.createTask({
      threadGroupId: backend.id,
      orgId: ORG_ID,
      title: 'Write the migration',
    });

    const frontend = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'build',
      title: 'Frontend',
    });
    const frontendBuilder = await store.createThreadInThreadGroup({
      threadGroupId: frontend.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'builder',
      brief: 'Frontend — render the view',
      ordinal: 400,
    });

    const master = await store.createThreadGroup({
      jobId: job.id,
      orgId: ORG_ID,
      kind: 'master_review',
    });
    await store.createThreadInThreadGroup({
      threadGroupId: master.id,
      jobId: job.id,
      orgId: ORG_ID,
      role: 'master_review',
      brief: 'Master review',
      ordinal: 500,
    });

    return {
      jobId: job.id,
      backendThreadGroupId: backend.id,
      frontendThreadGroupId: frontend.id,
      masterThreadGroupId: master.id,
      backendBuilderId: backendBuilder.id,
      frontendBuilderId: frontendBuilder.id,
      taskId: task.id,
      taskOrdinalId: String(task.ordinal),
    };
  }

  async function pollJobStatus(
    driver: ThreadDriver,
    jobId: string,
    until: (status: string) => boolean,
    timeoutMs = 60_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let shipApproved = false;
    let awaitingSince: number | null = null;
    let status = '';
    while (Date.now() < deadline) {
      const row = await jobs.findOneOrFail({ where: { id: jobId } });
      status = row.status;
      if (until(status)) break;
      // Belt-and-braces: the fixture opts into auto-approve so the gate resolves inline, but if a race ever
      // genuinely parks it, click "Ship it" so the drive continues. DEBOUNCED: the gate's own inline
      // auto-approve does a few DB round-trips right after the status flips (incl. spawning the post_build
      // thread at the gate) before it stamps the approval marker, so a status observed on the very first poll
      // may just be a mid-flight snapshot of that still-in-progress auto-approve. Clicking immediately would
      // race the in-flight CAS — and since a concurrent `drive()` is single-flight-guarded (see
      // ThreadDriver's `active` set), the loser's redrive is dropped, stranding the job. Require the status
      // to be sustained for a short grace window before treating it as genuinely parked.
      if (status === 'awaiting_ship_review') {
        awaitingSince ??= Date.now();
        if (!shipApproved && Date.now() - awaitingSince > 250) {
          shipApproved = true;
          await driver.resolveShipApprovalDurably(jobId, 'auto-test');
        }
      } else {
        awaitingSince = null;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    return status;
  }

  it(
    'drives planning→build×2→master_review→post_build→ci: a builder handoff rotates a 2nd builder into the ' +
      'SAME thread group sharing tasks (2a); review children are thread-group-scoped + run once (2b); the ship-review gate ' +
      'spawns post_build (2d); ship() spawns ci and openPrAtShip fires with the ci thread id (2e)',
    async () => {
      const seed = await seedPlan();

      // The backend builder must have a live session for a rotation to abandon (the fake engine's turn does
      // not itself persist one — the real recordActiveLeg does, but only AFTER the rotate decision).
      await store.setThreadSessionId(
        seed.backendBuilderId,
        'sess-backend-leg1',
      );

      const brainGateway = makeBrainGatewaySpy();
      const { turn, calls } = makeFakeTurn({
        rotateThreadId: seed.backendBuilderId,
      });
      const driver = makeDriver(turn, brainGateway);

      // ── #1: the fixture plan's thread groups exist in the right kind/order ────────────────────────────────
      const threadGroupsBefore = await store.threadGroupsForJob(seed.jobId);
      expect(threadGroupsBefore.map((s) => s.kind)).toEqual([
        'planning',
        'plan_review',
        'build',
        'build',
        'master_review',
      ]);

      await driver.dispatch(await store.loadJob(seed.jobId));
      const finalStatus = await pollJobStatus(
        driver,
        seed.jobId,
        (s) => s === 'done' || s === 'failed',
      );
      expect(finalStatus).toBe('done');

      // ── 2a: `record_leg_handoff` inserted a 2nd builder into the SAME thread group, sharing the thread group tasks ──
      const backendThreads = await store.threadsForThreadGroup(seed.backendThreadGroupId);
      const backendBuilders = backendThreads.filter(
        (t) => t.role === 'builder',
      );
      expect(backendBuilders).toHaveLength(2);
      const [leg1, leg2] = backendBuilders;
      expect(leg1.id).toBe(seed.backendBuilderId);
      expect(leg1.thread_group_id).toBe(seed.backendThreadGroupId);
      expect(leg2.thread_group_id).toBe(seed.backendThreadGroupId); // same thread group — the rotation appended, not re-grouped
      expect(leg2.handoff_in).toContain('finish the return type'); // the leg-1 handoff carried forward
      // The thread group's task checklist is thread-group-owned, so BOTH legs read the SAME list across the
      // rotation. `tasksForThreadGroup` returns raw rows (uuid PK); `getThreadTasks` maps to `TaskItem`
      // whose surfaced id is the short per-stage #N (the row's dense `ordinal`), not the uuid.
      const threadGroupTasks = await store.tasksForThreadGroup(seed.backendThreadGroupId);
      expect(threadGroupTasks.map((t) => t.id)).toEqual([seed.taskId]);
      const leg1Tasks = await store.getThreadTasks(leg1.id);
      const leg2Tasks = await store.getThreadTasks(leg2.id);
      expect(leg2Tasks.map((t) => t.id)).toEqual([seed.taskOrdinalId]);
      expect(leg2Tasks).toEqual(leg1Tasks); // identical checklist — the same thread_group_id, not per-leg

      // ── 2b: review_agent + review_fix are thread group children of the LAST builder, run ONCE over the diff ──
      const backendReviewers = backendThreads.filter(
        (t) => t.role === 'review_agent' || t.role === 'review_fix',
      );
      // Tree-parented off the LAST builder (leg 2), NOT leg 1 — review runs once, after the whole thread group.
      expect(
        backendReviewers.every((t) => t.parent_thread_id === leg2.id),
      ).toBe(true);
      // …but thread-group-scoped: every review child carries the build thread group's id.
      expect(
        backendReviewers.every((t) => t.thread_group_id === seed.backendThreadGroupId),
      ).toBe(true);
      expect(
        backendReviewers.filter((t) => t.role === 'review_agent').length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        backendReviewers.filter((t) => t.role === 'review_fix'),
      ).toHaveLength(1);
      // Run once, not per leg: leg 1 has NO review children of its own.
      const leg1Children = backendThreads.filter(
        (t) => t.parent_thread_id === leg1.id,
      );
      expect(leg1Children).toEqual([]);

      // Both build thread groups' builders + the master review all completed via the stubbed engine.
      const executeStepIds = calls
        .filter((c) => c.mode === 'execute')
        .map((c) => c.stepId);
      expect(executeStepIds).toContain(seed.backendBuilderId);
      expect(executeStepIds).toContain(leg2.id); // the fresh rotated leg drove its own turn
      expect(executeStepIds).toContain(seed.frontendBuilderId);

      // ── 2d: the ship-review GATE (right after master review, before/independent of ship approval)
      // spawned a post_build thread-group thread — it does NOT open the PR ──────────────────────────────
      const threadGroupsAfter = await store.threadGroupsForJob(seed.jobId);
      const postBuildThreadGroup = threadGroupsAfter.find(
        (s) => s.kind === 'post_build',
      );
      expect(postBuildThreadGroup).toBeTruthy();
      const [postBuildThread] = await store.threadsForThreadGroup(
        postBuildThreadGroup!.id,
      );
      expect(postBuildThread.role).toBe('post_build');

      // The gate delivers the post_build session's opening turn (the build summary + preview offer) via
      // `BrainGateway.seedPostBuildGate`, targeted at the freshly-spawned post_build thread — the live
      // proof that Thread 4's wiring (parkForShipReview → postBuildThreadId → seedPostBuildGate) actually
      // fires when the driver parks a real job at the ship-review gate.
      expect(brainGateway.seedPostBuildGate).toHaveBeenCalledTimes(1);
      expect(brainGateway.seedPostBuildGate).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: seed.jobId,
          threadId: postBuildThread.id,
        }),
      );

      // ── 2e: ship() spawned a ship thread-group thread and openPrAtShip fired with ITS (ship) thread id — PR
      // creation moved to ship, so it must NOT be the post_build thread's id ────────────────────────────
      const shipThreadGroup = threadGroupsAfter.find((s) => s.kind === 'ship');
      expect(shipThreadGroup).toBeTruthy();
      const [shipThread] = await store.threadsForThreadGroup(shipThreadGroup!.id);
      expect(shipThread.role).toBe('ship');
      expect(shipThread.id).not.toBe(postBuildThread.id);
      expect(brainGateway.openPrAtShip).toHaveBeenCalledTimes(1);
      expect(brainGateway.openPrAtShip).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: seed.jobId,
          threadId: shipThread.id,
        }),
      );

      const finalJob = await jobs.findOneOrFail({ where: { id: seed.jobId } });
      expect(finalJob.status).toBe('done');
      expect(finalJob.pr_url).toBe(
        'https://github.com/acme/pipeline-int/pull/7',
      );

      console.log(
        'OBSERVED thread group kinds (after ship):',
        threadGroupsAfter.map((s) => s.kind),
      );
    },
    90_000,
  );

  it(
    'a builder that ends without complete_thread lands NOT DONE (condition=incomplete) + stops the job ' +
      'driving, and the HEADLESS driver NEVER calls BrainGateway (2c: no brain wake on a halt)',
    async () => {
      const seed = await seedPlan();

      const brainGateway = makeBrainGatewaySpy();
      const { turn } = makeFakeTurn({
        incompleteThreadId: seed.backendBuilderId,
      });
      const driver = makeDriver(turn, brainGateway);

      await driver.dispatch(await store.loadJob(seed.jobId));

      // Poll for the "not done" state to land (the drive returns without shipping) — the thread's
      // `incomplete` condition is the durable signal (no terminal record, no reason taxonomy).
      const deadline = Date.now() + 30_000;
      let condition: string | null = null;
      while (Date.now() < deadline) {
        condition =
          (await store.getThread(seed.backendBuilderId).catch(() => null))
            ?.condition ?? null;
        if (condition === 'incomplete') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(condition).toBe('incomplete');

      // A not-done thread writes NO terminal record (`complete_thread` is the sole done-report).
      const term = await store.getTerminalRecord(seed.backendBuilderId);
      expect(term).toBeNull();

      // The job driving STOPPED for it: no ship, no PR, and the downstream thread groups never ran.
      const jobRow = await jobs.findOneOrFail({ where: { id: seed.jobId } });
      expect(jobRow.status).not.toBe('done');
      expect(jobRow.pr_url).toBeNull();
      const threadGroups = await store.threadGroupsForJob(seed.jobId);
      expect(threadGroups.some((s) => s.kind === 'post_build')).toBe(false);
      expect(threadGroups.some((s) => s.kind === 'ship')).toBe(false);
      // The frontend builder + master review never drove.
      const frontendBuilder = await threads.findOneOrFail({
        where: { id: seed.frontendBuilderId },
      });
      expect(frontendBuilder.status).toBe('pending');

      // ── 2c: the headless driver bounced NOTHING to the brain on the halt ─────────────────────────────
      expect(brainGateway.openPrAtShip).not.toHaveBeenCalled();
      expect(brainGateway.wakeUnblockedJob).not.toHaveBeenCalled();
    },
    60_000,
  );
});
