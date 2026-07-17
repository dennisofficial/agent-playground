
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type {
  EngineEvent,
  EngineRunnerPort,
  EngineRunResult,
  RunEngineArgs,
} from '@shared/engine/engine.types';
import { DataSource, Repository } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import type { LeaderElectionService } from '../../cluster/leader-election.service';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import type { TurnChunk } from '@shared/prompt-kit/harness/tag-vocabulary';
import type { TurnRegistry } from '../../sandbox/turn-registry.service';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { AgentSessionManager } from '../agent-session-manager.service';
import { JitHostExecutor } from '../jit-host-executor';

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

const ORG_ID = '61111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';
const OPERATOR = { id: 'operator-1', displayName: 'Dennis' };

describe('Atlas message-delivery pipeline (integration): real pump + real StimulusStoreService', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let stimulusStore: StimulusStoreService;
  let bootstrap: JobBootstrapService;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [JobBootstrapService, StimulusStoreService],
    }).compile();

    stimulusStore = mod.get(StimulusStoreService);
    bootstrap = mod.get(JobBootstrapService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Delivery Pipeline Org', 'delivery-pipeline-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'delivery-pipeline-repo', 'Delivery Pipeline Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE inbound_messages, transcript_messages, jobs RESTART IDENTITY CASCADE');
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  async function makeThread(title: string): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'chat',
        kind: 'feature',
        title,
      }),
    );
  }

  function makeManager(
    opts: {
      live?: boolean;
      jitChunks?: TurnChunk[];
      jitEnabled?: boolean;
      jit?: JitHostExecutor;
      memoryRecall?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const runningBrainTurn = vi
      .fn()
      .mockResolvedValue(opts.live ? { turn_id: 'turn-live-1', lane: 'main' } : null);
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;

    let capturedTask: string | undefined;
    const run = vi.fn((args: RunEngineArgs): Promise<EngineRunResult> => {
      capturedTask = args.task;
      args.onTurnRegistered?.('turn-fresh-1');
      args.onEvent?.({
        kind: 'session',
        sessionId: 'sess-1',
      } satisfies EngineEvent);
      return Promise.resolve({ result: 'ok' });
    });
    const steer = vi.fn().mockResolvedValue(undefined);
    const engineRunner = { run, steer } as unknown as EngineRunnerPort;

    const jobRow = {
      id: 'unused', // overwritten per call by the fake's captured jobId arg — loadJob ignores its arg here
      orgId: ORG_ID,
      repoId,
      status: 'open',
      kind: 'feature',
      halt: null,
      featureBranch: null,
    };
    const store = {
      loadJob: vi.fn().mockResolvedValue(jobRow),
      setActivity: vi.fn().mockResolvedValue(undefined),
      setHalted: vi.fn().mockResolvedValue(undefined),
      endTurnActivity: vi.fn().mockResolvedValue(undefined),
      clearBrainRetryCounters: vi.fn().mockResolvedValue(undefined),
      clearRetrySessionResume: vi.fn().mockResolvedValue(undefined),
      awaitingSecretId: vi.fn().mockResolvedValue(null),
      getSecretCard: vi.fn().mockResolvedValue(null),
      getQuestionCard: vi.fn().mockResolvedValue(null),
      getFileCard: vi.fn().mockResolvedValue(null),
      appendSystemEvent: vi.fn().mockResolvedValue(undefined),
      route: vi.fn().mockResolvedValue({ channel: 'main', threadTs: 'x' }),
      openQuestionCards: vi.fn().mockResolvedValue([]),
      openFileCards: vi.fn().mockResolvedValue([]),
      jobTitle: vi.fn().mockResolvedValue(null),
      markQuestionDelivered: vi.fn().mockResolvedValue(undefined),
      markSecretDelivered: vi.fn().mockResolvedValue(undefined),
      clearAwaitingSecret: vi.fn().mockResolvedValue(undefined),
      markFileDelivered: vi.fn().mockResolvedValue(undefined),
    };

    const lifecycle = {
      ensureProvisioned: vi.fn().mockResolvedValue(true),
      ensureContainer: vi.fn().mockResolvedValue({
        sandbox: { worktreePath: '/tmp', containerId: 'c1' },
        wasReset: false,
      }),
      findSandbox: vi.fn().mockResolvedValue({ id: 'sbx-1' }),
    };

    const sandboxRows = { findOne: vi.fn().mockResolvedValue(null) };
    const creds = { engineAuth: vi.fn().mockResolvedValue(undefined) };
    const mcp = { resolveForTurn: vi.fn().mockResolvedValue([]) };
    const prompts = { generate: () => 'SYSTEM' };
    const turnHarness = {
      create: () => ({
        onEvent: vi.fn(),
        emitPrompt: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
        discard: vi.fn().mockResolvedValue(undefined),
      }),
    };
    const election = {
      getState: () => 'follower',
    } as unknown as LeaderElectionService;
    const git = { currentBranch: vi.fn().mockResolvedValue(null) };
    const usage = { getResetAt: () => undefined };
    const memory = {
      recall: opts.memoryRecall ?? vi.fn().mockResolvedValue([]),
    };
    const jit =
      opts.jit ??
      (opts.jitChunks || opts.jitEnabled !== undefined
        ? ({
            hasEnabledOperatorPrepends: vi.fn().mockReturnValue(opts.jitEnabled ?? true),
            collectOperatorPrepends: vi.fn().mockReturnValue(opts.jitChunks ?? []),
          } as unknown as JitHostExecutor)
        : undefined);

    const inert = {} as never;
    const autoMerge = { maybeAutoMerge: vi.fn().mockResolvedValue(undefined) };
    const selfSufficiency = {
      buildTools: () => ({
        request_secret: vi.fn(),
        request_file: vi.fn(),
        recall: vi.fn(),
        remember: vi.fn(),
      }),
    };
    const manager = new AgentSessionManager(
      store as never, // store (1)
      inert, // driverStore (2)
      autoMerge as never, // autoMerge (3)
      memory as never, // memory (4)
      inert, // approvals (5)
      lifecycle as never, // lifecycle (6)
      engineRunner, // engineRunner (7)
      turnRegistry, // turnRegistry (8)
      inert, // planReview (9)
      inert, // dispatcher (10)
      inert, // surface (11)
      sandboxRows as never, // sandboxRows (12)
      inert, // stimulusRows (13)
      stimulusStore, // stimulusStore (14) — REAL, bound to Postgres
      turnHarness as never, // turnHarness (15)
      inert, // classifier (16)
      inert, // ship (17)
      inert, // repos (18)
      inert, // awareness (19)
      inert, // jobDeps (20)
      creds as never, // creds (21)
      mcp as never, // mcp (22)
      election, // election (23)
      inert, // turnRecovery (24)
      inert, // secretStore (25)
      inert, // configStore (26)
      git as never, // git (27)
      prompts as never, // prompts (28)
      inert, // threadInput (29)
      inert, // liveVerificationJudge (30)
      usage as never, // usage (31)
      selfSufficiency as never, // selfSufficiency (32)
      undefined, // usageProjector (33)
      undefined, // env (34)
      undefined, // conventions (35)
      undefined, // workspaceProfile (36)
      undefined, // skills (37)
      undefined, // skillStore (38)
      undefined, // skillFiles (39)
      undefined, // skillInstaller (40)
      undefined, // mcpStore (41)
      undefined, // scheduler (42)
      undefined, // brainGateway (43)
      undefined, // reattachRegistry (44)
      jit, // jit (45)
      undefined, // prodDiagnostics (46)
      undefined, // repoRows (47)
      undefined, // liveTurns (48)
      bootstrap, // jobBootstrap (49)
    );

    return {
      manager,
      runningBrainTurn,
      run,
      steer,
      getCapturedTask: () => capturedTask,
      jit,
    };
  }

  it('coalescing: 3 pending operator stimuli deliver as ONE fresh turn, chronological <user> chunks', async () => {
    const thread = await makeThread('coalescing thread');
    const { manager, run, steer, getCapturedTask } = makeManager();

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'first message',
    });
    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'second message',
    });
    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'third message',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    expect(steer).not.toHaveBeenCalled();

    const task = getCapturedTask();
    expect(task).toBeDefined();
    expect((task!.match(/<user /g) ?? []).length).toBe(3);
    const idx1 = task!.indexOf('first message');
    const idx2 = task!.indexOf('second message');
    const idx3 = task!.indexOf('third message');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);

    const pendingAfter = await stimulusStore.eligiblePendingChat(thread.id, 60_000);
    expect(pendingAfter).toHaveLength(0);
  });

  it('now steers a LIVE turn directly — never starts a fresh turn for it', async () => {
    const thread = await makeThread('now-steers-live thread');
    const { manager, run, steer } = makeManager({ live: true });

    const stim = await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'urgent now message',
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(steer).toHaveBeenCalledOnce();
    const [turnId, stimId, body] = steer.mock.calls[0] as [string, string, string];
    expect(turnId).toBe('turn-live-1');
    expect(stimId).toBe(stim.id);
    expect(body).toContain('urgent now message');
    expect(run).not.toHaveBeenCalled();
  });

  it('queue does NOT steer a live turn mid-flight — it waits for turn end', async () => {
    const thread = await makeThread('queue-does-not-steer thread');
    const { manager, run, steer } = makeManager({ live: true });

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'a queued follow-up, not urgent',
      priority: 'queue',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(steer).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();

    const pending = await stimulusStore.eligiblePendingChat(thread.id, 60_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].priority).toBe('queue');
  });

  it('later never wakes a turn on its own, but rides along the next turn that runs for any other reason', async () => {
    const thread = await makeThread('later-rides-along thread');
    const { manager, run, steer } = makeManager({ live: false });

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'a later note, no rush',
      priority: 'later',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(run).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'ok now this is urgent',
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
  });

  it('later + now: the fresh turn composes BOTH the ride-along later body and the now body', async () => {
    const thread = await makeThread('later-plus-now thread');
    const { manager, run, getCapturedTask } = makeManager({ live: false });

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'the later ride-along body',
      priority: 'later',
    });
    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(run).not.toHaveBeenCalled();

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'the now wake body',
      priority: 'now',
    });
    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    const task = getCapturedTask();
    expect(task).toBeDefined();
    expect(task).toContain('the later ride-along body');
    expect(task).toContain('the now wake body');
    expect(task!.indexOf('the later ride-along body')).toBeLessThan(
      task!.indexOf('the now wake body'),
    );
  });

  it('JIT turn-prefix memory rail: a collectOperatorPrepends chunk renders BEFORE the <user> chunk', async () => {
    const thread = await makeThread('jit-memory-rail thread');
    const memoryChunk: TurnChunk = {
      kind: 'system_reminder',
      body: 'MEMORY: recalled context',
      attrs: { reminderKind: 'memory' },
    };
    const { manager, run, getCapturedTask } = makeManager({
      live: false,
      jitChunks: [memoryChunk],
    });

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'a plain operator message',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    const task = getCapturedTask();
    expect(task).toBeDefined();
    const rendered = '<system_reminder source="memory">MEMORY: recalled context</system_reminder>';
    expect(task).toContain(rendered);
    expect(task).toContain('a plain operator message');
    expect(task!.indexOf(rendered)).toBeLessThan(task!.indexOf('<user'));
  });

  it('memory auto-recall hit renders through the real JIT rail before the operator message', async () => {
    const thread = await makeThread('memory-autorecall-real-jit thread');
    const recall = vi.fn().mockResolvedValue([
      {
        id: 'fact-1',
        fact: 'uses pnpm for package management',
        scope: `project:${repoId}`,
        sim: 0.91,
      },
    ]);
    const { manager, run, getCapturedTask } = makeManager({
      jit: new JitHostExecutor({} as never),
      memoryRecall: recall,
    });
    const body = 'what package manager does this repo use';

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body,
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    expect(recall).toHaveBeenCalledWith(
      body,
      expect.objectContaining({
        scopes: [`project:${repoId}`, `team:${ORG_ID}`],
        orgId: ORG_ID,
        limit: 3,
        floor: 0.45,
      }),
    );
    const task = getCapturedTask();
    expect(task).toContain('<system_reminder source="memory">');
    expect(task).toContain('uses pnpm for package management');
    expect(task!.indexOf('source="memory"')).toBeLessThan(task!.indexOf('<user'));
  });

  it('JIT memory rail disabled: skips auto-recall before any embedding/recall call', async () => {
    const thread = await makeThread('jit-memory-disabled thread');
    const recall = vi.fn().mockResolvedValue([
      {
        id: 'fact-1',
        fact: 'uses pnpm',
        scope: `project:${repoId}`,
        sim: 0.9,
      },
    ]);
    const { manager, run, getCapturedTask } = makeManager({
      jitEnabled: false,
      memoryRecall: recall,
    });

    await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'what package manager does this repo use',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    expect(recall).not.toHaveBeenCalled();
    expect(getCapturedTask()).not.toContain('source="memory"');
  });
});
