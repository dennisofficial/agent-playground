/**
 * Delivery-priority (d18: now|queue|later) — DB-query proof against LIVE Postgres.
 *
 * Proves the persistence contract StimulusStoreService actually relies on for the priority/wake
 * behavior described in Thread 5:
 *
 *  (a) `recordChatStimulus({ ..., priority: 'later' })` piggybacks `priority` INSIDE the existing
 *      `reply_route` jsonb column (no new column) — the raw row's `reply_route->>'priority'` reads back
 *      'later', and the read path (`rowToChatStimulus`, exercised via `eligiblePendingChat`) round-trips
 *      it onto the returned `ChatStimulus.priority`.
 *  (b) `undeliveredChatThreads` — the sweep worklist that WAKES a thread — excludes a thread whose only
 *      pending chat stimulus is priority 'later', but includes a thread with a 'now' (or
 *      undefined-priority, which defaults to 'now') pending stimulus.
 *  (c) `eligiblePendingChat` (the per-thread ride-along read used once a turn is already running) is
 *      UNCHANGED by priority — it still returns every pending row for a thread, including 'later' ones.
 *
 * Integration: real Postgres (atlas_test schema), no fakes — StimulusStoreService wired against a real
 * DataSource, mirroring driver/driver-store.int.test.ts's bootstrap pattern.
 */

import { Test, type TestingModule } from '@nestjs/testing';
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
import { JobBootstrapService } from '../job-bootstrap';
import { StimulusStoreService } from './stimulus-store.service';

const ORG_ID = '51111111-1111-4111-8111-111111111111';
const BASE_BRANCH = 'main';

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

describe('delivery priority (now|queue|later) — live Postgres DB-query proof', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: StimulusStoreService;
  let jobs: Repository<JobEntity>;
  let repoId: string;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [JobBootstrapService, StimulusStoreService],
    }).compile();

    store = mod.get(StimulusStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Delivery Priority Org', 'delivery-priority-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'delivery-priority-repo', 'Delivery Priority Repo', 'https://github.com/x/y.git', $2, NULL, true)
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

  it('(a) persists `priority` inside reply_route jsonb and round-trips it on read', async () => {
    const thread = await makeThread('priority persistence thread');

    const returned = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'ride-along note for later',
      priority: 'later',
    });

    // The in-memory return value already carries it back.
    expect(returned.priority).toBe('later');

    // The RAW row: priority lives INSIDE reply_route jsonb, no dedicated column.
    const raw = await ds.query(
      `SELECT reply_route, reply_route ->> 'priority' AS priority_text FROM inbound_messages WHERE id = $1`,
      [returned.id],
    );
    expect(raw).toHaveLength(1);
    expect(raw[0].priority_text).toBe('later');
    expect(raw[0].reply_route).toMatchObject({
      surfaceId: 'web',
      jobRef: thread.id,
      priority: 'later',
    });

    // The read path (rowToChatStimulus, exercised via eligiblePendingChat) round-trips priority.
    const pending = await store.eligiblePendingChat(thread.id, 60_000);
    expect(pending).toHaveLength(1);
    expect(pending[0].priority).toBe('later');
    expect(pending[0].id).toBe(returned.id);
  });

  it('(b) undeliveredChatThreads excludes an all-"later" thread but includes a "now"/undefined thread', async () => {
    const laterThread = await makeThread('later-only thread');
    const nowThread = await makeThread('now-priority thread');
    const undefinedThread = await makeThread('undefined-priority thread');

    await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: laterThread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: laterThread.id },
      body: 'only a later note — must not wake this thread',
      priority: 'later',
    });

    await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: nowThread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: nowThread.id },
      body: 'an urgent now note — must wake this thread',
      priority: 'now',
    });

    await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: undefinedThread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: undefinedThread.id },
      body: 'a plain note with no priority set — defaults to now, must wake this thread',
      // priority intentionally omitted
    });

    const worklist = await store.undeliveredChatThreads();
    const jobIds = worklist.map((w) => w.jobId);

    expect(jobIds).not.toContain(laterThread.id);
    expect(jobIds).toContain(nowThread.id);
    expect(jobIds).toContain(undefinedThread.id);
  });

  it('(c) eligiblePendingChat is unaffected by priority — returns the full ride-along set including "later"', async () => {
    const thread = await makeThread('mixed-priority ride-along thread');

    const now = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'first: now',
      priority: 'now',
    });
    const queued = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'second: queue',
      priority: 'queue',
    });
    const later = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: { id: 'operator-1', displayName: 'Dennis' },
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: 'third: later',
      priority: 'later',
    });

    const pending = await store.eligiblePendingChat(thread.id, 60_000);
    expect(pending.map((p) => p.id)).toEqual([now.id, queued.id, later.id]); // oldest-first, ride-along set unaffected
    expect(pending.map((p) => p.priority)).toEqual(['now', 'queue', 'later']);

    // Sanity: this thread WOULD wake anyway (it has non-'later' pending rows), confirming (b)'s filter
    // doesn't ALSO leak into eligiblePendingChat's row set.
    const worklist = await store.undeliveredChatThreads();
    expect(worklist.map((w) => w.jobId)).toContain(thread.id);
  });
});
