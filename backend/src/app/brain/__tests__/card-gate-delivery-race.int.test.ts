
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
import type { LeaderElectionService } from '../../cluster';
import { JobBootstrapService } from '../../job-bootstrap';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import {
  BrainTurnAlreadyRunningError,
  type TurnRegistry,
} from '../../sandbox/turn-registry.service';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { SYSTEM_SEED_AUTHOR } from '../../surface/chat-surface.port';
import { AgentSessionManager } from '../agent-session-manager.service';

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

const ORG_ID = '62222222-2222-4222-8222-222222222222';
const BASE_BRANCH = 'main';
const OPERATOR = { id: 'operator-1', displayName: 'Dennis' };
const SEED_AUTHOR = {
  id: SYSTEM_SEED_AUTHOR.id,
  displayName: SYSTEM_SEED_AUTHOR.name,
};

type ManagerInternals = {
  pumpThread: (jobId: string, orgId: string, repoId: string) => Promise<void>;
  sweepUndeliveredChat: () => Promise<void>;
  reattachOne: (row: unknown) => Promise<void>;
};
const priv = (m: AgentSessionManager) => m as unknown as ManagerInternals;

describe('Card/gate delivery lost-wakeup race (integration): durable pump stamps only on real consumption', () => {
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
      [ORG_ID, 'Card Gate Race Org', 'card-gate-race-org-2'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'card-gate-race-repo', 'Card Gate Race Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await purgeOwnRows().catch(() => undefined);
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE inbound_messages, transcript_messages, jobs RESTART IDENTITY CASCADE');
  });

  async function purgeOwnRows(): Promise<void> {
    if (!ds?.isInitialized) return;
    await ds.query('DELETE FROM inbound_messages WHERE org_id = $1', [ORG_ID]);
    await ds.query(
      'DELETE FROM transcript_messages WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $1)',
      [ORG_ID],
    );
    await ds.query('DELETE FROM active_turns WHERE org_id = $1', [ORG_ID]);
    await ds.query('DELETE FROM jobs WHERE org_id = $1', [ORG_ID]);
  }

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
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

  async function recordSeed(
    jobId: string,
    body: string,
    target: {
      seedQuestionId?: string;
      seedSecretId?: string;
      seedFileId?: string;
      seedQuestionIds?: string[];
      seedSecretIds?: string[];
      seedFileIds?: string[];
      priority?: 'now' | 'queue' | 'later';
    },
  ) {
    return stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId,
      author: SEED_AUTHOR,
      replyRoute: { surfaceId: 'web', jobRef: jobId },
      body,
      systemChunk: 'skip',
      ...(target.priority ? { priority: target.priority } : {}),
      ...(target.seedQuestionId ? { seedQuestionId: target.seedQuestionId } : {}),
      ...(target.seedSecretId ? { seedSecretId: target.seedSecretId } : {}),
      ...(target.seedFileId ? { seedFileId: target.seedFileId } : {}),
      ...(target.seedQuestionIds ? { seedQuestionIds: target.seedQuestionIds } : {}),
      ...(target.seedSecretIds ? { seedSecretIds: target.seedSecretIds } : {}),
      ...(target.seedFileIds ? { seedFileIds: target.seedFileIds } : {}),
    });
  }

  async function rowState(
    id: string,
  ): Promise<{ delivered_at: Date | null; attempted_at: Date | null }> {
    const rows = await ds.query(
      'SELECT delivered_at, attempted_at FROM inbound_messages WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function expireLease(jobId: string): Promise<void> {
    await ds.query('UPDATE inbound_messages SET attempted_at = NULL WHERE job_id = $1', [jobId]);
  }

  function makeManager(opts: { live?: boolean; leader?: boolean } = {}) {
    let liveTurn: string | null = opts.live ? 'turn-live-1' : null;
    const runningBrainTurn = vi.fn(async () =>
      liveTurn ? { turn_id: liveTurn, lane: 'main' } : null,
    );
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;

    let capturedTask: string | undefined;
    let runImpl: ((args: RunEngineArgs) => Promise<EngineRunResult>) | null = null;
    const run = vi.fn((args: RunEngineArgs): Promise<EngineRunResult> => {
      capturedTask = args.task;
      if (runImpl) return runImpl(args);
      args.onTurnRegistered?.('turn-fresh-1');
      args.onEvent?.({
        kind: 'session',
        sessionId: 'sess-1',
      } satisfies EngineEvent);
      return Promise.resolve({ result: 'ok' });
    });
    const steer = vi.fn().mockResolvedValue(undefined);
    const reattach = vi.fn().mockResolvedValue({ result: 'ok' });
    const tryClaimAttach = vi.fn().mockReturnValue(true);
    const engineRunner = {
      run,
      steer,
      reattach,
      tryClaimAttach,
    } as unknown as EngineRunnerPort;

    const jobRow = {
      id: 'unused',
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
      hasRecentSystemOperatorNotice: vi.fn().mockResolvedValue(false),
      appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      appendSystemNotice: vi.fn().mockResolvedValue(undefined),
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
      resetLane: vi.fn(),
    };
    const election = {
      getState: () => (opts.leader ? 'leader' : 'follower'),
    } as unknown as LeaderElectionService;
    const git = { currentBranch: vi.fn().mockResolvedValue(null) };
    const usage = { getResetAt: () => undefined };

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
      inert, // memory (4)
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
      undefined, // jit (45)
      undefined, // prodDiagnostics (46)
      undefined, // repoRows (47)
      undefined, // liveTurns (48)
      bootstrap, // jobBootstrap (49)
    );

    return {
      manager,
      run,
      steer,
      store,
      getCapturedTask: () => capturedTask,
      setLive: (turnId: string | null) => {
        liveTurn = turnId;
      },
      setRunImpl: (impl: ((args: RunEngineArgs) => Promise<EngineRunResult>) | null) => {
        runImpl = impl;
      },
    };
  }

  it('bfe355ae — an ANSWER steered into a mid-turn brain is NOT stamped on the XADD (no ack, no stamp)', async () => {
    const thread = await makeThread('question race thread');
    const { manager, run, steer, store } = makeManager({
      live: true,
      leader: true,
    });
    store.getQuestionCard.mockResolvedValue({
      answer: 'the answer',
      deliveredAt: null,
    });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    const after = await rowState(seed.id);
    expect(after.delivered_at).toBeNull();
    expect(after.attempted_at).not.toBeNull();
  });

  it('bfe355ae repro + sweep re-drive: the stranded answer is re-driven fresh and BOTH card + row land delivered', async () => {
    const thread = await makeThread('question race + sweep thread');
    const h = makeManager({ live: true, leader: true });
    const { manager, run, steer, store } = h;
    store.getQuestionCard.mockResolvedValue({
      answer: 'the answer',
      deliveredAt: null,
    });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    h.setLive(null);
    await expireLease(thread.id);

    const worklist = await stimulusStore.undeliveredChatThreads();
    expect(worklist.some((t) => t.jobId === thread.id)).toBe(true);
    await expect(priv(manager).sweepUndeliveredChat()).resolves.toBeUndefined();

    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(run).toHaveBeenCalledOnce();
    expect(store.markQuestionDelivered).toHaveBeenCalledOnce();
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  it('generalized coalescing: an operator message + a pending seed answer drain as ONE turn, both delivered', async () => {
    const thread = await makeThread('seed-plus-operator coalesce thread');
    const { manager, run, store, getCapturedTask } = makeManager({
      live: false,
      leader: true,
    });
    store.getQuestionCard.mockResolvedValue({
      answer: 'the answer',
      deliveredAt: null,
    });

    const framed = '<system_notice>your question was answered</system_notice>';
    const seed = await recordSeed(thread.id, framed, { seedQuestionId: 'q-1' });
    const operator = await stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'a normal operator reply',
      priority: 'later',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    const task = getCapturedTask();
    expect(task).toBeDefined();
    expect(task).toContain(framed);
    expect(task).not.toContain('<user name="System"');
    expect(task).toContain('a normal operator reply');
    expect(task).toContain('<user name="Dennis"');
    expect(task!.indexOf(framed)).toBeLessThan(task!.indexOf('a normal operator reply'));

    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
    expect((await rowState(operator.id)).delivered_at).not.toBeNull();
    const stillPending = await stimulusStore.eligiblePendingChat(thread.id, 60_000);
    expect(stillPending).toHaveLength(0);
  });

  it('secret parity (Codex wedge): a provided-secret steered mid-turn is NOT stamped; the sweep clears the gate', async () => {
    const thread = await makeThread('secret race thread');
    const h = makeManager({ live: true, leader: true });
    const { manager, run, steer, store } = h;
    store.awaitingSecretId.mockResolvedValue('sec-1');
    store.getSecretCard.mockResolvedValue({
      provided_at: new Date(),
      delivered_at: null,
      ephemeral: true,
    });

    const seed = await recordSeed(thread.id, '<system_notice>secret provided</system_notice>', {
      seedSecretId: 'sec-1',
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(store.markSecretDelivered).not.toHaveBeenCalled();
    expect(store.clearAwaitingSecret).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    h.setLive(null);
    await expireLease(thread.id);
    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    expect(store.markSecretDelivered).toHaveBeenCalledWith(thread.id, 'sec-1');
    expect(store.clearAwaitingSecret).toHaveBeenCalledWith(thread.id, 'sec-1');
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  it('fresh-turn failure atomicity: a register-then-die turn leaves BOTH card + row unstamped; the sweep recovers', async () => {
    const thread = await makeThread('fresh-turn atomicity thread');
    const h = makeManager({ live: false, leader: true });
    const { manager, store } = h;
    store.getQuestionCard.mockResolvedValue({
      answer: 'the answer',
      deliveredAt: null,
    });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    h.setRunImpl((args) => {
      args.onTurnRegistered?.('turn-fresh-1');
      return Promise.reject(new Error('engine died before success tail'));
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId).catch(() => {});

    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    h.setRunImpl(null);
    await expireLease(thread.id);
    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(store.markQuestionDelivered).toHaveBeenCalledOnce();
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  describe('reattach exactly-once: a seed completed via reattach stamps its card + row and is not re-swept', () => {
    type Variant = {
      name: string;
      target: {
        seedQuestionId?: string;
        seedSecretId?: string;
        seedFileId?: string;
      };
      arm: (store: ReturnType<typeof makeManager>['store']) => void;
      assertCard: (store: ReturnType<typeof makeManager>['store'], jobId: string) => void;
    };
    const variants: Variant[] = [
      {
        name: 'question',
        target: { seedQuestionId: 'q-1' },
        arm: (store) =>
          store.getQuestionCard.mockResolvedValue({
            answer: 'the answer',
            deliveredAt: null,
          }),
        assertCard: (store, jobId) =>
          expect(store.markQuestionDelivered).toHaveBeenCalledWith(jobId, 'q-1'),
      },
      {
        name: 'secret',
        target: { seedSecretId: 'sec-1' },
        arm: (store) =>
          store.getSecretCard.mockResolvedValue({
            provided_at: new Date(),
            delivered_at: null,
            ephemeral: true,
          }),
        assertCard: (store, jobId) => {
          expect(store.markSecretDelivered).toHaveBeenCalledWith(jobId, 'sec-1');
          expect(store.clearAwaitingSecret).toHaveBeenCalledWith(jobId, 'sec-1');
        },
      },
      {
        name: 'file',
        target: { seedFileId: 'file-1' },
        arm: (store) =>
          store.getFileCard.mockResolvedValue({
            provided_at: new Date(),
            delivered_at: null,
          }),
        assertCard: (store, jobId) =>
          expect(store.markFileDelivered).toHaveBeenCalledWith(jobId, 'file-1'),
      },
    ];

    for (const v of variants) {
      it(`${v.name} variant`, async () => {
        const thread = await makeThread(`reattach ${v.name} thread`);
        const { manager, store } = makeManager({ leader: true });
        v.arm(store);

        const seed = await recordSeed(thread.id, '<system_notice>reattached seed</system_notice>', {
          ...v.target,
          priority: 'now',
        });

        const row = {
          turn_id: `turn-reattach-${v.name}`,
          job_id: thread.id,
          org_id: ORG_ID,
          channel: repoId,
          lane: 'main',
          kind: 'brain',
          container_id: 'c1',
          ctx: {
            repoId,
            author: SEED_AUTHOR,
            body: '<system_notice>reattached seed</system_notice>',
            seed: true,
            deliveryStimulusIds: [seed.id],
            ...v.target,
          },
        };

        await priv(manager).reattachOne(row);

        v.assertCard(store, thread.id);
        expect((await rowState(seed.id)).delivered_at).not.toBeNull();

        const worklist = await stimulusStore.undeliveredChatThreads();
        expect(worklist.some((t) => t.jobId === thread.id)).toBe(false);
      });
    }
  });

  it('combined answer-batch seed: 3 cards (question + file + durable secret) deliver as ONE turn; the success tail stamps all three', async () => {
    const thread = await makeThread('batch delivery thread');
    const { manager, run, store } = makeManager({ live: false, leader: true });
    store.getQuestionCard.mockResolvedValue({
      answer: 'the answer',
      deliveredAt: null,
    });
    store.getFileCard.mockResolvedValue({
      provided_at: new Date(),
      delivered_at: null,
    });
    store.getSecretCard.mockResolvedValue({
      provided_at: new Date(),
      delivered_at: null,
    });

    const seed = await recordSeed(thread.id, '<system_notice>batch of 3</system_notice>', {
      seedQuestionIds: ['q-1'],
      seedFileIds: ['file-1'],
      seedSecretIds: ['sec-1'],
      priority: 'now',
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(run).toHaveBeenCalledOnce();
    expect(store.markQuestionDelivered).toHaveBeenCalledWith(thread.id, 'q-1');
    expect(store.markFileDelivered).toHaveBeenCalledWith(thread.id, 'file-1');
    expect(store.markSecretDelivered).toHaveBeenCalledWith(thread.id, 'sec-1');
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  it('crash-recovery guard: hasChatStimulusForSeedTarget recognizes every card an undelivered COMBINED batch seed carries, so the boot per-card backfill enqueues no duplicate', async () => {
    const thread = await makeThread('batch crash-recovery thread');
    await recordSeed(thread.id, '<system_notice>batch of 3</system_notice>', {
      seedQuestionIds: ['q-1'],
      seedFileIds: ['file-1'],
      seedSecretIds: ['sec-1'],
    });

    expect(
      await stimulusStore.hasChatStimulusForSeedTarget(thread.id, {
        seedQuestionId: 'q-1',
      }),
    ).toBe(true);
    expect(
      await stimulusStore.hasChatStimulusForSeedTarget(thread.id, {
        seedFileId: 'file-1',
      }),
    ).toBe(true);
    expect(
      await stimulusStore.hasChatStimulusForSeedTarget(thread.id, {
        seedSecretId: 'sec-1',
      }),
    ).toBe(true);
    expect(
      await stimulusStore.hasChatStimulusForSeedTarget(thread.id, {
        seedQuestionId: 'q-2',
      }),
    ).toBe(false);
  });
});

describe('atomic stimulus claim (d2): kills the delivery self-race', () => {
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
      [ORG_ID, 'Card Gate Race Org', 'card-gate-race-org-2'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'card-gate-race-repo', 'Card Gate Race Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await purgeOwnRows().catch(() => undefined);
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE inbound_messages, transcript_messages, jobs RESTART IDENTITY CASCADE');
  });

  async function purgeOwnRows(): Promise<void> {
    if (!ds?.isInitialized) return;
    await ds.query('DELETE FROM inbound_messages WHERE org_id = $1', [ORG_ID]);
    await ds.query(
      'DELETE FROM transcript_messages WHERE job_id IN (SELECT id FROM jobs WHERE org_id = $1)',
      [ORG_ID],
    );
    await ds.query('DELETE FROM active_turns WHERE org_id = $1', [ORG_ID]);
    await ds.query('DELETE FROM jobs WHERE org_id = $1', [ORG_ID]);
  }

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
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

  async function rowState(
    id: string,
  ): Promise<{ delivered_at: Date | null; attempted_at: Date | null }> {
    const rows = await ds.query(
      'SELECT delivered_at, attempted_at FROM inbound_messages WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  async function expireLease(jobId: string): Promise<void> {
    await ds.query('UPDATE inbound_messages SET attempted_at = NULL WHERE job_id = $1', [jobId]);
  }

  async function waitForDelivered(id: string): Promise<void> {
    const deadline = Date.now() + 2000;
    for (;;) {
      if ((await rowState(id)).delivered_at !== null) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function recordOperator(jobId: string, body: string) {
    return stimulusStore.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: jobId },
      body,
    });
  }

  function makeManager(opts: { live?: boolean; leader?: boolean } = {}) {
    let liveTurn: string | null = opts.live ? 'turn-live-1' : null;
    const runningBrainTurn = vi.fn(async () =>
      liveTurn ? { turn_id: liveTurn, lane: 'main' } : null,
    );
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;

    let capturedTask: string | undefined;
    let runImpl: ((args: RunEngineArgs) => Promise<EngineRunResult>) | null = null;
    const run = vi.fn((args: RunEngineArgs): Promise<EngineRunResult> => {
      capturedTask = args.task;
      if (runImpl) return runImpl(args);
      args.onTurnRegistered?.('turn-fresh-1');
      args.onEvent?.({
        kind: 'session',
        sessionId: 'sess-1',
      } satisfies EngineEvent);
      return Promise.resolve({ result: 'ok' });
    });
    const steer = vi.fn().mockResolvedValue(undefined);
    const reattach = vi.fn().mockResolvedValue({ result: 'ok' });
    const tryClaimAttach = vi.fn().mockReturnValue(true);
    const engineRunner = {
      run,
      steer,
      reattach,
      tryClaimAttach,
    } as unknown as EngineRunnerPort;

    const jobRow = {
      id: 'unused',
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
      hasRecentSystemOperatorNotice: vi.fn().mockResolvedValue(false),
      appendSystemOperatorMessage: vi.fn().mockResolvedValue(undefined),
      appendAtlasMessage: vi.fn().mockResolvedValue(undefined),
      appendSystemNotice: vi.fn().mockResolvedValue(undefined),
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
      resetLane: vi.fn(),
    };
    const election = {
      getState: () => (opts.leader ? 'leader' : 'follower'),
    } as unknown as LeaderElectionService;
    const git = { currentBranch: vi.fn().mockResolvedValue(null) };
    const usage = { getResetAt: () => undefined };

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
      inert, // memory (4)
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
      undefined, // jit (45)
      undefined, // prodDiagnostics (46)
      undefined, // repoRows (47)
      undefined, // liveTurns (48)
      bootstrap, // jobBootstrap (49)
    );

    return {
      manager,
      run,
      steer,
      store,
      getCapturedTask: () => capturedTask,
      setLive: (turnId: string | null) => {
        liveTurn = turnId;
      },
      setRunImpl: (impl: ((args: RunEngineArgs) => Promise<EngineRunResult>) | null) => {
        runImpl = impl;
      },
    };
  }

  it('claimChatStimuli: exactly one concurrent claimer wins, and the loser gets []', async () => {
    const thread = await makeThread('atomic claim thread');
    const stimulus = await recordOperator(thread.id, 'race me for delivery');

    const [a, b] = await Promise.all([
      stimulusStore.claimChatStimuli([stimulus.id], 60_000),
      stimulusStore.claimChatStimuli([stimulus.id], 60_000),
    ]);
    const winners = [a, b].filter((r) => r.length > 0);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual([stimulus.id]);

    const claimed = await rowState(stimulus.id);
    expect(claimed.attempted_at).not.toBeNull();
    expect(claimed.delivered_at).toBeNull();

    await expireLease(thread.id);
    const reclaimed = await stimulusStore.claimChatStimuli([stimulus.id], 60_000);
    expect(reclaimed).toEqual([stimulus.id]);
  });

  it('regression: two concurrent pumpThread callers on the same pending message never both drive a turn (no self-steer)', async () => {
    const thread = await makeThread('cross-process claim race thread');
    const h1 = makeManager({ live: false, leader: true });
    const h2 = makeManager({ live: false, leader: true });

    const stimulus = await recordOperator(thread.id, 'one message, two callers');

    await Promise.all([
      h1.manager.pumpThread(thread.id, ORG_ID, repoId),
      h2.manager.pumpThread(thread.id, ORG_ID, repoId),
    ]);

    const h1Ran = h1.run.mock.calls.length > 0;
    const h2Ran = h2.run.mock.calls.length > 0;
    expect(h1Ran).not.toBe(h2Ran);
    if (h1Ran) {
      expect(h1.run).toHaveBeenCalledOnce();
      expect(h2.run).not.toHaveBeenCalled();
    } else {
      expect(h2.run).toHaveBeenCalledOnce();
      expect(h1.run).not.toHaveBeenCalled();
    }

    expect(h1.steer).not.toHaveBeenCalled();
    expect(h2.steer).not.toHaveBeenCalled();

    await waitForDelivered(stimulus.id);
    expect((await rowState(stimulus.id)).delivered_at).not.toBeNull();
  });

  it('coalesced-batch registration-loss ack: each claimed member is steered + acked individually, not once under the combined id', async () => {
    const thread = await makeThread('coalesced registration-loss thread');
    const h = makeManager({ live: false, leader: true });
    const { manager, steer } = h;

    const s1 = await recordOperator(thread.id, 'message one');
    const s2 = await recordOperator(thread.id, 'message two');

    h.setRunImpl(() => {
      h.setLive('turn-live-1');
      return Promise.reject(new BrainTurnAlreadyRunningError(thread.id));
    });
    steer.mockImplementation(async (_turnId: string, id: string) => {
      await stimulusStore.markChatDelivered(id);
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(steer).toHaveBeenCalledTimes(2);
    expect((await rowState(s1.id)).delivered_at).not.toBeNull();
    expect((await rowState(s2.id)).delivered_at).not.toBeNull();
  });
});
