import type { ModuleRef } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { JobBootstrapService } from '../../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import type { TurnRunnerService } from '../../runner/turn-runner.service';
import { TurnRegistry } from '../../sandbox/turn-registry.service';
import { DeliveryPump } from '../../stimulus/delivery-pump.service';
import { StimulusStoreService } from '../../stimulus/stimulus-store.service';
import { ThreadInputService } from '../../surface/thread-input.service';
import { laneFor } from '../../surface/thread-registry';
import { BuildLaneDeliveryService } from '../build-lane-delivery.service';
import type { DriverStoreService } from '../driver-store.service';

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
  const fakeDriverStore = {
    stepsForThread: async () => [],
    recordBuildSystemChunk: async () => undefined,
  } as unknown as DriverStoreService;
  const fakeThreadInput = {
    register: () => undefined,
  } as unknown as ThreadInputService;
  const fakeModuleRef = { get: () => ({}) } as unknown as ModuleRef;

  let seeder: BuildLaneDeliveryService;

  const lane = laneFor('builder', THREAD_ID);

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOpts()), TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION)],
      providers: [JobBootstrapService, StimulusStoreService, DeliveryPump, TurnRegistry],
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
      'TRUNCATE inbound_messages, transcript_messages, active_turns, jobs RESTART IDENTITY CASCADE',
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
      `SELECT id, delivered_at, attempted_at FROM inbound_messages WHERE job_id = $1 AND lane = $2`,
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
      `SELECT lane, author_id, author_name, kind, reply_route FROM inbound_messages WHERE id = $1`,
      [seed.id],
    );
    expect(rows[0].lane).toBe(lane);
    expect(rows[0].author_id).toBe('U-SYSTEM');
    expect(rows[0].author_name).toBe('System');
    expect(rows[0].kind).toBe('chat');
    expect(rows[0].reply_route.priority).toBe('queue');

    const msgCount = await ds.query(
      `SELECT COUNT(*)::int AS n FROM transcript_messages WHERE job_id = $1`,
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

    expect(steerCalls).toHaveLength(1);
    expect(steerCalls[0].turnId).toBe('5bbbbbbb-2222-4222-8222-222222222222');
    expect(steerCalls[0].body).toBe('steer me now');

    const before = await rawSeed(job.id);
    expect(before.delivered_at).toBeNull();
    expect(before.attempted_at).not.toBeNull();

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

    expect(steerCalls).toHaveLength(0);
    const row = await rawSeed(job.id);
    expect(row.delivered_at).toBeNull();

    const pending = await store.eligiblePendingChat(job.id, 2 * 60 * 1000, lane);
    expect(pending.map((p) => p.body)).toContain('queued work');

    await store.markChatDelivered(row.id);
    const afterPending = await store.eligiblePendingChat(job.id, 2 * 60 * 1000, lane);
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

    expect(await store.eligiblePendingChat(job.id, 2 * 60 * 1000, lane)).toHaveLength(0);
    expect(await store.undeliveredChatForLane(job.id, lane)).toHaveLength(1);

    await store.rekeyLaneToMain(
      seed.id,
      'Undelivered host seed from build thread thread-1: leased leftover',
    );

    const rows = await ds.query(
      `SELECT lane, attempted_at, delivered_at, body FROM inbound_messages WHERE id = $1`,
      [seed.id],
    );
    expect(rows[0].lane).toBe('main');
    expect(rows[0].attempted_at).toBeNull();
    expect(rows[0].delivered_at).toBeNull();
    expect(rows[0].body).toContain('leased leftover');

    const mainPending = await store.eligiblePendingChat(job.id, 2 * 60 * 1000, 'main');
    expect(mainPending.map((p) => p.id)).toContain(seed.id);
  });

  it('(d) a build lane accepts operator input once a handler is registered; a genuinely read-only kind never does', () => {
    const input = new ThreadInputService();
    expect(input.canPost(lane)).toBe(false);
    input.register('builder', { post: async () => undefined });
    expect(input.canPost(lane)).toBe(true);

    expect(input.canPost(laneFor('autofix-lens', 'af-1', 'lens-1'))).toBe(false);
  });

  it('(e) pump() re-drives a pending `now` seed into a live steerable Leg — the build-lane sweep backstop', async () => {
    const job = await makeJob();
    await seeder.seedLane(
      { jobId: job.id, orgId: ORG_ID, repoId, threadId: THREAD_ID },
      'swallowed steer',
      'now',
    );
    expect(steerCalls).toHaveLength(0);

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
