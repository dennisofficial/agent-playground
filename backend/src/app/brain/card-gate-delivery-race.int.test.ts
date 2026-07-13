/**
 * Card/gate delivery lost-wakeup race — INTEGRATION proof against a REAL Postgres DB.
 *
 * The regression under test is prod race bfe355ae: an operator answer / provided-secret / uploaded-file that
 * lands while the brain is MID-TURN was being falsely marked delivered on the steer XADD and then never
 * re-driven — the card `deliveredAt` (+ the `stimuli.delivered_at` row) got stamped before the engine ever
 * consumed it, so a turn that died before acking left the answer stranded forever.
 *
 * The fix routes every card/gate delivery through the durable chat stimulus pump. The card + its `stimuli` row
 * are stamped ONLY on real consumption — the engine `input_ack` on the steer path, or the fresh-turn / reattach
 * SUCCESS tail — and the periodic `sweepUndeliveredChat` re-drives anything left undelivered. These specs drive
 * the REAL pump (`pumpThread` → steer / fresh-turn / reattach) against a REAL `StimulusStoreService` bound to
 * Postgres; only the leaf engine/sandbox are faked. The card store (`BrainStoreService`) is faked, so a card's
 * delivered state is "was `markQuestionDelivered` called", while `stimuli.delivered_at` is a real DB column.
 *
 * Harness copied from `delivery-pipeline.int.test.ts` (same DB bootstrap + 44-arg manager wiring), extended with
 * a mutable live-turn holder (`setLive`), a swappable engine `run` (`setRunImpl`), a leader toggle, and the
 * reattach fakes (`tryClaimAttach`/`reattach`/`turnHarness.resetLane`).
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
import { SYSTEM_SEED_AUTHOR } from '../surface/chat-surface.port';
import type {
  EngineEvent,
  EngineRunnerPort,
  EngineRunResult,
  RunEngineArgs,
} from '../engine/engine.types';
import type { TurnRegistry } from '../sandbox/turn-registry.service';
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
    connectTimeoutMS: 10_000,
    ssl: false as const,
  };
}

const ORG_ID = '61111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';
const OPERATOR = { id: 'operator-1', displayName: 'Dennis' };
const SEED_AUTHOR = { id: SYSTEM_SEED_AUTHOR.id, displayName: SYSTEM_SEED_AUTHOR.name };

/** Reach the manager's private pump/sweep/reattach entry points, exactly as the existing specs do. */
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
      [ORG_ID, 'Card Gate Race Org', 'card-gate-race-org'],
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
    await mod?.close();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE stimuli, messages, jobs RESTART IDENTITY CASCADE');
  });

  // Several pump paths end their turn by firing a fire-and-forget re-pump that re-queries the REAL pending
  // table. Give any stray in-flight query a beat to land before the next test TRUNCATEs the table out from
  // under it — a hygiene guard, not a correctness gate (every assertion below reads state synchronously right
  // after its own `await`). A touch longer than the template's 150ms because these cases fan out more re-pumps.
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

  /** Record a durable SYSTEM-SEED chat stimulus (auto-`seed:true`) carrying a card-delivery target. */
  async function recordSeed(
    jobId: string,
    body: string,
    target: {
      seedQuestionId?: string;
      seedSecretId?: string;
      seedFileId?: string;
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
      // 'skip' writes NEITHER an operator bubble nor a curated pill — the stimulus row is written regardless,
      // which is all the durable pump needs. Keeps the transcript-side assertions out of scope.
      systemChunk: 'skip',
      ...(target.priority ? { priority: target.priority } : {}),
      ...(target.seedQuestionId ? { seedQuestionId: target.seedQuestionId } : {}),
      ...(target.seedSecretId ? { seedSecretId: target.seedSecretId } : {}),
      ...(target.seedFileId ? { seedFileId: target.seedFileId } : {}),
    });
  }

  /** Real `stimuli` row state for one stimulus id (the durable at-least-once ledger). */
  async function rowState(id: string): Promise<{ delivered_at: Date | null; attempted_at: Date | null }> {
    const rows = await ds.query(
      'SELECT delivered_at, attempted_at FROM stimuli WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  /** Clear the delivery lease so a subsequent sweep/pump can re-collect a row a dead steer left owed. */
  async function expireLease(jobId: string): Promise<void> {
    await ds.query('UPDATE stimuli SET attempted_at = NULL WHERE job_id = $1', [jobId]);
  }

  /**
   * Build a fresh `AgentSessionManager` wired to the REAL `stimulusStore` (arg 13). Verbatim from
   * `delivery-pipeline.int.test.ts`'s `makeManager`, extended with: a mutable live-turn holder (`setLive`), a
   * swappable engine `run` (`setRunImpl`) so a case can inject a register-then-die run, a `leader` toggle
   * (the sweep early-returns unless leader), and the reattach fakes (`tryClaimAttach`/`reattach`/`resetLane`).
   */
  function makeManager(opts: { live?: boolean; leader?: boolean } = {}) {
    let liveTurn: string | null = opts.live ? 'turn-live-1' : null;
    const runningBrainTurn = vi.fn(async () =>
      liveTurn ? { turn_id: liveTurn } : null,
    );
    const turnRegistry = { runningBrainTurn } as unknown as TurnRegistry;

    let capturedTask: string | undefined;
    let runImpl: ((args: RunEngineArgs) => Promise<EngineRunResult>) | null = null;
    const run = vi.fn((args: RunEngineArgs): Promise<EngineRunResult> => {
      capturedTask = args.task;
      if (runImpl) return runImpl(args);
      args.onTurnRegistered?.('turn-fresh-1');
      args.onEvent?.({ kind: 'session', sessionId: 'sess-1' } satisfies EngineEvent);
      return Promise.resolve({ result: 'ok' });
    });
    // The steer XADDs but emits NO `input_ack` — the very race: the turn dies before acking, so nothing must
    // be stamped. Kept as a handle to assert it fired.
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
      // Error-path fakes (only a register-then-die turn reaches these) so the failure tail doesn't throw on a
      // missing method — leaving the assertions to prove nothing was stamped.
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
      // Reattach drops any stranded live-turn state before replaying the stream.
      resetLane: vi.fn(),
    };
    const election = {
      getState: () => (opts.leader ? 'leader' : 'follower'),
    } as unknown as LeaderElectionService;
    const git = { currentBranch: vi.fn().mockResolvedValue(null) };
    const usage = { getResetAt: () => undefined };

    const inert = {} as never;
    const autoMerge = { maybeAutoMerge: vi.fn().mockResolvedValue(undefined) };
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
      undefined, // usageProjector (32)
      undefined, // env (33)
      undefined, // conventions (34)
      undefined, // workspaceProfile (35)
      undefined, // skills (36)
      undefined, // skillStore (37)
      undefined, // skillFiles (38)
      undefined, // skillInstaller (39)
      undefined, // mcpStore (40)
      undefined, // scheduler (41)
      undefined, // brainGateway (42)
      undefined, // reattachRegistry (43)
      undefined, // jit (44)
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
    const { manager, run, steer, store } = makeManager({ live: true, leader: true });
    store.getQuestionCard.mockResolvedValue({ answer: 'the answer', deliveredAt: null });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    // MID-TURN: the pump steers the live turn; the steer XADDs but the turn dies before any `input_ack`.
    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    // THE RACE FIX: nothing is stamped on the XADD — not the card, not the durable row. The lease IS taken
    // (attempted_at set), so the answer stays owed for the sweep rather than being lost.
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    const after = await rowState(seed.id);
    expect(after.delivered_at).toBeNull();
    expect(after.attempted_at).not.toBeNull();
  });

  it('bfe355ae repro + sweep re-drive: the stranded answer is re-driven fresh and BOTH card + row land delivered', async () => {
    const thread = await makeThread('question race + sweep thread');
    const h = makeManager({ live: true, leader: true });
    const { manager, run, steer, store } = h;
    store.getQuestionCard.mockResolvedValue({ answer: 'the answer', deliveredAt: null });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    // 1) MID-TURN steer — no ack, nothing stamped.
    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    // 2) Turn goes idle + the dead steer's lease expires → the answer is now sweep-eligible.
    h.setLive(null);
    await expireLease(thread.id);

    // The real sweep worklist finds the stranded thread (leader-gated query over undelivered chat rows).
    const worklist = await stimulusStore.undeliveredChatThreads();
    expect(worklist.some((t) => t.jobId === thread.id)).toBe(true);
    // Prove the private sweep doesn't throw (its fan-out is fire-and-forget — we don't depend on it below).
    await expect(priv(manager).sweepUndeliveredChat()).resolves.toBeUndefined();

    // 3) Deterministically complete the re-drive ourselves: a FRESH turn now runs, and the SUCCESS TAIL (the
    //    real production stamp mechanism) stamps the card + the durable row together.
    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(run).toHaveBeenCalledOnce();
    expect(store.markQuestionDelivered).toHaveBeenCalledOnce();
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  it('regression: an operator message + a pending seed answer → the seed delivers SOLO, framed, operator untouched', async () => {
    const thread = await makeThread('seed-solo-vs-operator thread');
    const { manager, run, store, getCapturedTask } = makeManager({ live: false, leader: true });
    store.getQuestionCard.mockResolvedValue({ answer: 'the answer', deliveredAt: null });

    const framed = '<system_notice>your question was answered</system_notice>';
    // Seed is the OLDER (head) row; a seed head delivers solo (never coalesced into a `<user>` batch).
    const seed = await recordSeed(thread.id, framed, { seedQuestionId: 'q-1' });
    // A `later` operator reply stays deterministically pending: the seed's turn-end re-pump won't wake a
    // later-only remainder, so the operator row is provably untouched (no lease, no stamp).
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

    // The seed delivered SOLO: one fresh turn, the RAW framed body in the task, never wrapped as a `<user>`.
    expect(run).toHaveBeenCalledOnce();
    const task = getCapturedTask();
    expect(task).toBeDefined();
    expect(task).toContain(framed);
    expect(task).not.toContain('<user name="System"');
    expect(task).not.toContain('a normal operator reply');

    // The seed's durable row is stamped (success tail); the operator row is UNAFFECTED — still pending.
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
    expect((await rowState(operator.id)).delivered_at).toBeNull();
    const stillPending = await stimulusStore.eligiblePendingChat(thread.id, 60_000);
    expect(stillPending.map((p) => p.body)).toContain('a normal operator reply');
  });

  it('secret parity (Codex wedge): a provided-secret steered mid-turn is NOT stamped; the sweep clears the gate', async () => {
    const thread = await makeThread('secret race thread');
    const h = makeManager({ live: true, leader: true });
    const { manager, run, steer, store } = h;
    store.awaitingSecretId.mockResolvedValue('sec-1');
    store.getSecretCard.mockResolvedValue({ provided_at: new Date(), delivered_at: null });

    const seed = await recordSeed(thread.id, '<system_notice>secret provided</system_notice>', {
      seedSecretId: 'sec-1',
      priority: 'now',
    });

    // 1) MID-TURN steer — no ack. The gate must stay SET and the card undelivered (never wedged half-open).
    await manager.pumpThread(thread.id, ORG_ID, repoId);
    expect(steer).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(store.markSecretDelivered).not.toHaveBeenCalled();
    expect(store.clearAwaitingSecret).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    // 2) Turn idle + lease expired → fresh re-drive stamps the card, clears the gate, and marks the row.
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
    store.getQuestionCard.mockResolvedValue({ answer: 'the answer', deliveredAt: null });

    const seed = await recordSeed(thread.id, '<system_notice>answer q-1</system_notice>', {
      seedQuestionId: 'q-1',
      priority: 'now',
    });

    // Register (so the turn is restart-survivable) then die BEFORE the success tail runs.
    h.setRunImpl((args) => {
      args.onTurnRegistered?.('turn-fresh-1');
      return Promise.reject(new Error('engine died before success tail'));
    });

    await manager.pumpThread(thread.id, ORG_ID, repoId).catch(() => {});

    // A seed defers its row stamp to the success tail (which never ran) — so NOTHING is stamped, and the
    // sweep still owns the answer (at-least-once atomicity: card and row move together or not at all).
    expect(store.markQuestionDelivered).not.toHaveBeenCalled();
    expect((await rowState(seed.id)).delivered_at).toBeNull();

    // Recovery: a healthy run + an expired lease → the next re-drive stamps BOTH.
    h.setRunImpl(null);
    await expireLease(thread.id);
    await manager.pumpThread(thread.id, ORG_ID, repoId);

    expect(store.markQuestionDelivered).toHaveBeenCalledOnce();
    expect((await rowState(seed.id)).delivered_at).not.toBeNull();
  });

  describe('reattach exactly-once: a seed completed via reattach stamps its card + row and is not re-swept', () => {
    type Variant = {
      name: string;
      target: { seedQuestionId?: string; seedSecretId?: string; seedFileId?: string };
      arm: (store: ReturnType<typeof makeManager>['store']) => void;
      assertCard: (store: ReturnType<typeof makeManager>['store'], jobId: string) => void;
    };
    const variants: Variant[] = [
      {
        name: 'question',
        target: { seedQuestionId: 'q-1' },
        arm: (store) =>
          store.getQuestionCard.mockResolvedValue({ answer: 'the answer', deliveredAt: null }),
        assertCard: (store, jobId) =>
          expect(store.markQuestionDelivered).toHaveBeenCalledWith(jobId, 'q-1'),
      },
      {
        name: 'secret',
        target: { seedSecretId: 'sec-1' },
        arm: (store) =>
          store.getSecretCard.mockResolvedValue({ provided_at: new Date(), delivered_at: null }),
        assertCard: (store, jobId) => {
          expect(store.markSecretDelivered).toHaveBeenCalledWith(jobId, 'sec-1');
          expect(store.clearAwaitingSecret).toHaveBeenCalledWith(jobId, 'sec-1');
        },
      },
      {
        name: 'file',
        target: { seedFileId: 'file-1' },
        arm: (store) =>
          store.getFileCard.mockResolvedValue({ provided_at: new Date(), delivered_at: null }),
        assertCard: (store, jobId) =>
          expect(store.markFileDelivered).toHaveBeenCalledWith(jobId, 'file-1'),
      },
    ];

    for (const v of variants) {
      it(`${v.name} variant`, async () => {
        const thread = await makeThread(`reattach ${v.name} thread`);
        const { manager, store } = makeManager({ leader: true });
        v.arm(store);

        const seed = await recordSeed(
          thread.id,
          '<system_notice>reattached seed</system_notice>',
          { ...v.target, priority: 'now' },
        );

        // An `active_turns`-shaped row whose ctx carries the durable stimulus id, so the reattach success tail
        // stamps the RIGHT row (the reconstructed ChatStimulus.id is the engine turn id, not the stimuli id).
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
            deliveryStimulusId: seed.id,
            ...v.target,
          },
        };

        await priv(manager).reattachOne(row);

        // The reattach success tail stamped BOTH the card and the durable row (exactly-once consumption).
        v.assertCard(store, thread.id);
        expect((await rowState(seed.id)).delivered_at).not.toBeNull();

        // A consumed seed is no longer in the sweep worklist — it can never be re-delivered.
        const worklist = await stimulusStore.undeliveredChatThreads();
        expect(worklist.some((t) => t.jobId === thread.id)).toBe(false);
      });
    }
  });
});
