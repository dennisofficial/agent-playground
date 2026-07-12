/**
 * Atlas message-delivery pipeline — END-TO-END integration proof against a REAL Postgres DB.
 *
 * Drives the REAL pump code (`AgentSessionManager.pumpThread` → `collectPendingForTurn` →
 * `deliverPendingViaFreshTurn`/`steerPending` → `runChatTurn` → `runChatTurnInner` → `composeTurn`) with a
 * REAL `StimulusStoreService` bound to a real Postgres connection (the durable operator-message inbox: lease/
 * mark-delivered/eligible-pending queries all hit the actual database). Only the leaf SDK/container boundary is
 * faked — `engineRunner` (no real Claude/Codex process) and `lifecycle` (no real Docker sandbox) — everything
 * ELSE that decides WHAT gets delivered, WHEN, and HOW it's framed is the real production code path. This is
 * what a unit test (which fakes `stimulusStore` itself) cannot prove: that coalescing, now|queue|later
 * priority steering, the `composeTurn` hub framing, and the JIT turn-prefix "memory" rail all actually execute
 * live through the real delivery pipeline, not just through hand-fed fixtures.
 *
 * DB bootstrap pattern copied from `stimulus/delivery-priority.int.test.ts` (real TypeOrmModule against
 * localhost:5433 / atlas_test). Manager construction mirrors the `pumpThread` describe block in
 * `agent-session-manager.spec.ts` and `collect-pending-for-turn.spec.ts` — same positional-arg wiring, with
 * `stimulusStore` (arg 13) swapped for the REAL service instead of a fake.
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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, JobEntity } from '../persistence/entities';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { AgentSessionManager } from './agent-session-manager.service';
import type { JitHostExecutor } from './jit-host-executor';
import type {
  EngineEvent,
  EngineRunnerPort,
  EngineRunResult,
  RunEngineArgs,
} from '../engine/engine.types';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
import type { LeaderElectionService } from '../cluster';
import type { TurnChunk } from '../prompt-kit/harness';

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
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [StimulusStoreService],
    }).compile();

    stimulusStore = mod.get(StimulusStoreService);
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
    await ds.query('TRUNCATE stimuli, messages, jobs RESTART IDENTITY CASCADE');
  });

  // Several pump paths end their turn by firing a fire-and-forget re-pump (`runChatTurn`'s `finally`) that
  // re-queries the REAL `eligiblePendingChat` table. Give any such stray in-flight query a beat to land
  // before the next test TRUNCATEs the table out from under it — a hygiene guard, not a correctness gate
  // (the assertions below all read state synchronously right after their own `await pumpThread(...)`, which
  // is safe: the recursive query cannot possibly resolve — a real network round trip — inside that same
  // microtask flush).
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

  /**
   * Build a fresh `AgentSessionManager`, wired to the REAL `stimulusStore` (arg 13) and otherwise the
   * minimal set of fakes `pumpThread`/`runChatTurnInner` actually touch (traced end-to-end from the
   * source) — mirroring `agent-session-manager.spec.ts`'s `pumpThread` `makeManager()` and
   * `collect-pending-for-turn.spec.ts`'s constructor wiring, but deep enough to run a full
   * `runChatTurnInner` turn against the fake leaf engine/sandbox.
   */
  function makeManager(opts: { live?: boolean; jitChunks?: TurnChunk[] } = {}) {
    const runningBrainTurn = vi
      .fn()
      .mockResolvedValue(opts.live ? { turn_id: 'turn-live-1' } : null);
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
    const jit = opts.jitChunks
      ? ({
          collectOperatorPrepends: vi.fn().mockReturnValue(opts.jitChunks),
        } as unknown as JitHostExecutor)
      : undefined;

    const inert = {} as never;
    const manager = new AgentSessionManager(
      store as never, // store (1)
      inert, // driverStore (2)
      inert, // memory (3)
      inert, // approvals (4)
      lifecycle as never, // lifecycle (5)
      engineRunner, // engineRunner (6)
      turnRegistry, // turnRegistry (7)
      inert, // planReview (8)
      inert, // dispatcher (9)
      inert, // surface (10)
      sandboxRows as never, // sandboxRows (11)
      inert, // stimulusRows (12)
      stimulusStore, // stimulusStore (13) — REAL, bound to Postgres
      turnHarness as never, // turnHarness (14)
      inert, // classifier (15)
      inert, // ship (16)
      inert, // repos (17)
      inert, // awareness (18)
      inert, // jobDeps (19)
      creds as never, // creds (20)
      mcp as never, // mcp (21)
      election, // election (22)
      inert, // turnRecovery (23)
      inert, // secretStore (24)
      inert, // configStore (25)
      git as never, // git (26)
      prompts as never, // prompts (27)
      inert, // threadInput (28)
      inert, // liveVerificationJudge (29)
      usage as never, // usage (30)
      undefined, // usageProjector (31)
      undefined, // env (32)
      undefined, // conventions (33)
      undefined, // workspaceProfile (34)
      undefined, // skills (35)
      undefined, // skillStore (36)
      undefined, // skillFiles (37)
      undefined, // skillInstaller (38)
      undefined, // mcpStore (39)
      undefined, // scheduler (40)
      undefined, // brainGateway (41)
      undefined, // reattachRegistry (42)
      jit, // jit (43)
    );

    return {
      manager,
      runningBrainTurn,
      run,
      steer,
      getCapturedTask: () => capturedTask,
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
    // 3 chronological `<user>` chunks — one per coalesced message, oldest first (send order).
    expect((task!.match(/<user /g) ?? []).length).toBe(3);
    const idx1 = task!.indexOf('first message');
    const idx2 = task!.indexOf('second message');
    const idx3 = task!.indexOf('third message');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);

    // Restart-survivable hand-off: all 3 rows are stamped delivered once the turn registers.
    const pendingAfter = await stimulusStore.eligiblePendingChat(
      thread.id,
      60_000,
    );
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
    const [turnId, stimId, body] = steer.mock.calls[0] as [
      string,
      string,
      string,
    ];
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

    // Still pending — a `queue` message is never dropped, only deferred.
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

    // A `later`-only thread: no wake at all.
    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(run).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();

    // A `now` message arrives for the same thread — wakes a fresh turn that composes BOTH messages.
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
    // No wake yet.
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
    // Chronological: the `later` row was created first, so it renders first.
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
    const rendered =
      '<system_reminder source="memory">MEMORY: recalled context</system_reminder>';
    expect(task).toContain(rendered);
    expect(task).toContain('a plain operator message');
    expect(task!.indexOf(rendered)).toBeLessThan(task!.indexOf('<user'));
  });
});
