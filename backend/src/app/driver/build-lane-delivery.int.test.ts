/**
 * Build-lane host-seed delivery (Thread 2) — DB-query proof against LIVE Postgres.
 *
 * A build lane (`thread:<threadId>`) rides the SAME lane-generic `DeliveryPump` the brain uses. These tests
 * prove the HOST-SEED delivery contract end-to-end over real rows (the operator-input transport that now also
 * rides this lane is a separately-registered handler — see (d)):
 *
 *  (a) `recordHostSeed` writes ONLY the durable `stimuli` row (no operator `messages` bubble), on the build
 *      lane, System-authored, with `priority` piggybacked into `reply_route` — the delivery ledger works while
 *      never rendering an operator bubble.
 *  (b) FAST PATH: a `now` seed with a LIVE steerable Leg (`active_turns` kind:'step', lane:'thread:<id>',
 *      running, steerable) is STEERED into the live turn (the pump takes the live path); the row is leased but
 *      NOT yet delivered — the engine `input_ack` (simulated via `markChatDelivered`) stamps `delivered_at`.
 *  (c) SLOW PATH: a `queue` seed with NO live turn stays PENDING (no steer, `delivered_at` null) and remains
 *      eligible for the next-Leg drain; stamping it delivered (the register hand-off) removes it from the queue.
 *  (d) A build lane accepts operator input once a handler registers — `canPost('thread:<id>')` is true — while
 *      a genuinely read-only kind (`input:'none'`, e.g. autofix-lens) stays `canPost === false`.
 *
 * Integration: real Postgres (atlas_test schema), StimulusStoreService + DeliveryPump + TurnRegistry wired
 * against a real DataSource, mirroring driver/driver-store.int.test.ts's bootstrap. The TurnRunner + the two
 * DriverStore methods BuildLaneDeliveryService touches are faked (the runner steer transport / visible-row
 * writer are proven elsewhere).
 */

import { Test, type TestingModule } from '@nestjs/testing';
import type { ModuleRef } from '@nestjs/core';
import {
  TypeOrmModule,
  getDataSourceToken,
  getRepositoryToken,
} from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../persistence/database.module';
import { ENTITIES, JobEntity } from '../persistence/entities';
import { StimulusStoreService, DeliveryPump } from '../stimulus';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { ThreadInputService } from '../surface/thread-input.service';
import { laneFor } from '../surface/thread-registry';
import type { TurnRunnerService } from '../runner';
import type { DriverStoreService } from './driver-store.service';
import { BuildLaneDeliveryService } from './build-lane-delivery.service';

const ORG_ID = '52222222-2222-4222-8222-222222222222';
const BASE_BRANCH = 'main';
const THREAD_ID = '5aaaaaaa-2222-4222-8222-222222222222';

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

describe('build-lane host-seed delivery — live Postgres proof', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: StimulusStoreService;
  let pump: DeliveryPump;
  let registry: TurnRegistry;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  const steerCalls: Array<{ turnId: string; id: string; body: string }> = [];
  const fakeRunner = {
    canSteer: () => true,
    steer: async (turnId: string, id: string, body: string) => {
      steerCalls.push({ turnId, id, body });
    },
  } as unknown as TurnRunnerService;
  // The two DriverStore methods BuildLaneDeliveryService touches — empty steps ⇒ the display-only visible-row
  // write is skipped, so this int test isolates the DELIVERY ledger (the visible-row writer is proven elsewhere).
  const fakeDriverStore = {
    stepsForThread: async () => [],
    recordBuildSystemChunk: async () => undefined,
  } as unknown as DriverStoreService;
  // Delivery-mechanics tests exercise seedLane/pump only — the operator-input transport (which is the sole
  // consumer of these two) is not registered here, so bare stubs suffice.
  const fakeThreadInput = {
    register: () => undefined,
  } as unknown as ThreadInputService;
  // redriveThread (the halted-thread path) is not exercised by these delivery-mechanics tests — a
  // ModuleRef stub that's never actually asked to resolve ThreadDriver suffices.
  const fakeModuleRef = { get: () => ({}) } as unknown as ModuleRef;

  let seeder: BuildLaneDeliveryService;

  const lane = laneFor('builder', THREAD_ID);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [StimulusStoreService, DeliveryPump, TurnRegistry],
    }).compile();

    store = mod.get(StimulusStoreService);
    pump = mod.get(DeliveryPump);
    registry = mod.get(TurnRegistry);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));
    seeder = new BuildLaneDeliveryService(
      pump,
      store,
      registry,
      fakeRunner,
      fakeDriverStore,
      fakeThreadInput,
      fakeModuleRef,
    );

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Build Lane Org', 'build-lane-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'build-lane-repo', 'Build Lane Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    steerCalls.length = 0;
    await ds.query(
      'TRUNCATE stimuli, messages, active_turns, jobs RESTART IDENTITY CASCADE',
    );
  });

  async function makeJob(): Promise<JobEntity> {
    return jobs.save(
      jobs.create({
        org_id: ORG_ID,
        repo_id: repoId,
        origin: 'chat',
        kind: 'feature',
        title: 'build lane job',
      }),
    );
  }

  async function rawSeed(jobId: string): Promise<{
    id: string;
    delivered_at: string | null;
    attempted_at: string | null;
  }> {
    const rows = await ds.query(
      `SELECT id, delivered_at, attempted_at FROM stimuli WHERE job_id = $1 AND lane = $2`,
      [jobId, lane],
    );
    return rows[0];
  }

  it('(a) recordHostSeed writes ONLY the stimulus row (no operator bubble), on the lane, System-authored, priority piggybacked', async () => {
    const job = await makeJob();

    const seed = await store.recordHostSeed({
      orgId: ORG_ID,
      repoId,
      jobId: job.id,
      lane,
      body: 'host seed body',
      priority: 'queue',
    });

    expect(seed.author.id).toBe('U-SYSTEM');
    expect(seed.priority).toBe('queue');

    const rows = await ds.query(
      `SELECT lane, author_id, author_name, kind, reply_route FROM stimuli WHERE id = $1`,
      [seed.id],
    );
    expect(rows[0].lane).toBe(lane);
    expect(rows[0].author_id).toBe('U-SYSTEM');
    expect(rows[0].author_name).toBe('System');
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].reply_route.priority).toBe('queue');

    // NO operator bubble — the whole point of a no-bubble recorder (build lanes are read-only).
    const msgCount = await ds.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE job_id = $1`,
      [job.id],
    );
    expect(msgCount[0].n).toBe(0);
  });

  it('(b) a `now` seed with a LIVE steerable Leg is steered into the live turn; input_ack stamps delivered_at', async () => {
    const job = await makeJob();
    await registry.register({
      turnId: '5bbbbbbb-2222-4222-8222-222222222222',
      jobId: job.id,
      orgId: ORG_ID,
      channel: repoId,
      lane,
      kind: 'step',
      steerable: true,
      ctx: {},
    });

    await seeder.seedLane(
      { jobId: job.id, orgId: ORG_ID, repoId, threadId: THREAD_ID },
      'steer me now',
      'now',
    );

    // The pump took the LIVE path: exactly one steer into the running turn, carrying the seed body verbatim.
    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].turnId).toBe('5bbbbbbb-2222-4222-8222-222222222222');
    expect(steerCalls[0].body).toBe('steer me now');

    // Leased but NOT yet delivered — steer only leases; the engine input_ack owns the delivered stamp.
    const before = await rawSeed(job.id);
    expect(before.delivered_at).toBeNull();
    expect(before.attempted_at).not.toBeNull();

    // Simulate the engine `input_ack` the driver's onEvent handler stamps.
    await store.markChatDelivered(before.id);
    const after = await rawSeed(job.id);
    expect(after.delivered_at).not.toBeNull();
  });

  it('(c) a `queue` seed with NO live turn stays PENDING and remains eligible for the next-Leg drain', async () => {
    const job = await makeJob();

    await seeder.seedLane(
      { jobId: job.id, orgId: ORG_ID, repoId, threadId: THREAD_ID },
      'queued work',
      'queue',
    );

    // No live turn ⇒ no steer, and the row stays pending (the drain-path descriptor is a no-op).
    expect(steerCalls).toHaveLength(0);
    const row = await rawSeed(job.id);
    expect(row.delivered_at).toBeNull();

    // Still eligible — this is exactly what the next `kickBatchTurn` folds into the Leg task.
    const pending = await store.eligiblePendingChat(
      job.id,
      2 * 60 * 1000,
      lane,
    );
    expect(pending.map((p) => p.body)).toContain('queued work');

    // The register hand-off stamps it delivered → it drops out of the queue.
    await store.markChatDelivered(row.id);
    const afterPending = await store.eligiblePendingChat(
      job.id,
      2 * 60 * 1000,
      lane,
    );
    expect(afterPending).toHaveLength(0);
  });

  it('(c2) terminal escalation re-keys leased leftovers to main and clears the lease', async () => {
    const job = await makeJob();
    const seed = await store.recordHostSeed({
      orgId: ORG_ID,
      repoId,
      jobId: job.id,
      lane,
      body: 'leased leftover',
      priority: 'now',
    });
    await store.leaseChatStimuli([seed.id]);

    expect(
      await store.eligiblePendingChat(job.id, 2 * 60 * 1000, lane),
    ).toHaveLength(0);
    expect(await store.undeliveredChatForLane(job.id, lane)).toHaveLength(1);

    await store.rekeyLaneToMain(
      seed.id,
      'Undelivered host seed from build thread thread-1: leased leftover',
    );

    const rows = await ds.query(
      `SELECT lane, attempted_at, delivered_at, body FROM stimuli WHERE id = $1`,
      [seed.id],
    );
    expect(rows[0].lane).toBe('main');
    expect(rows[0].attempted_at).toBeNull();
    expect(rows[0].delivered_at).toBeNull();
    expect(rows[0].body).toContain('leased leftover');

    const mainPending = await store.eligiblePendingChat(
      job.id,
      2 * 60 * 1000,
      'main',
    );
    expect(mainPending.map((p) => p.id)).toContain(seed.id);
  });

  it('(d) a build lane accepts operator input once a handler is registered; a genuinely read-only kind never does', () => {
    const input = new ThreadInputService();
    // Before any handler registers, even an input-enabled lane can't be posted to (boot-order gate).
    expect(input.canPost(lane)).toBe(false);
    input.register('builder', { post: async () => undefined });
    expect(input.canPost(lane)).toBe(true);

    // A kind that stays `input:'none'` (autofix-lens) is never postable — the read-only gate still holds even
    // with no handler in the way.
    expect(input.canPost(laneFor('autofix-lens', 'af-1', 'lens-1'))).toBe(
      false,
    );
  });

  it('(e) pump() re-drives a pending `now` seed into a live steerable Leg — the build-lane sweep backstop', async () => {
    const job = await makeJob();
    // Seed with NO live turn yet — a `now` seed whose original steer was swallowed stays pending, exactly
    // the shape the sweep must recover.
    await seeder.seedLane(
      { jobId: job.id, orgId: ORG_ID, repoId, threadId: THREAD_ID },
      'swallowed steer',
      'now',
    );
    expect(steerCalls).toHaveLength(0);

    // A Leg goes live AFTER the seed — the sweep tick's re-drive, not the original seedLane call, must steer it.
    await registry.register({
      turnId: '5cccccc1-2222-4222-8222-222222222222',
      jobId: job.id,
      orgId: ORG_ID,
      channel: repoId,
      lane,
      kind: 'step',
      steerable: true,
      ctx: {},
    });

    await seeder.pump({
      jobId: job.id,
      orgId: ORG_ID,
      repoId,
      threadId: THREAD_ID,
    });

    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].body).toBe('swallowed steer');
  });
});
