/**
 * Send-state correlation — DB-query proof against LIVE Postgres.
 *
 * A CASE-3 composed send (an operator note riding WITH answered cards) must land the note as its OWN durable
 * operator bubble — NOT a "…+ a message" summary pill — correlated to its delivery-ledger row so send/delivery
 * state can be stamped on both. This proves that contract end-to-end against a real DB:
 *  - `recordChatStimulus({ operatorBubbleText })` writes exactly ONE operator bubble (text = the note),
 *    correlated via `stimulus_id`, `delivered_at` still NULL (sending), and NO pill row;
 *  - `markChatDelivered` stamps BOTH the `inbound_messages` row and the correlated `transcript_messages`
 *    row, is idempotent, and emits the realtime nudge exactly once per real state change.
 *
 * Integration: real Postgres (atlas_test), StimulusStoreService wired against a real DataSource with a spy
 * MESSAGE_CHANGE_NOTIFIER, mirroring silent-seed.int.test.ts's bootstrap pattern.
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
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { DB_CONNECTION } from '../../persistence/database.module';
import { ENTITIES, JobEntity } from '../../persistence/entities';
import { JobBootstrapService } from '../job-bootstrap';
import { MESSAGE_CHANGE_NOTIFIER } from '../../surface/message-change-notifier.port';
import { StimulusStoreService } from '../stimulus-store.service';

const ORG_ID = '53333333-3333-4333-8333-333333333333';
const BASE_BRANCH = 'main';
const OPERATOR = { id: 'U-OPERATOR', displayName: 'Dennis' };

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

type TranscriptRow = {
  id: string;
  text: string;
  stimulus_id: string | null;
  delivered_at: Date | null;
  author_bot_id: string | null;
};

describe('send-state correlation — live Postgres DB-query proof', () => {
  let mod: TestingModule;
  let ds: DataSource;
  let store: StimulusStoreService;
  let jobs: Repository<JobEntity>;
  let repoId: string;
  const notifier = { emitMessagesChanged: vi.fn() };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(dbOpts()),
        TypeOrmModule.forFeature(ENTITIES, DB_CONNECTION),
      ],
      providers: [
        JobBootstrapService,
        StimulusStoreService,
        { provide: MESSAGE_CHANGE_NOTIFIER, useValue: notifier },
      ],
    }).compile();

    store = mod.get(StimulusStoreService);
    ds = mod.get<DataSource>(getDataSourceToken(DB_CONNECTION));
    jobs = mod.get(getRepositoryToken(JobEntity, DB_CONNECTION));

    await ds.query(
      `INSERT INTO organizations (id, name, slug, status) VALUES ($1, $2, $3, 'active')
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ORG_ID, 'Send State Org', 'send-state-org'],
    );
    const repoRows = await ds.query(
      `INSERT INTO repos (org_id, slug, name, git_url, default_branch, token_name, access_ok)
       VALUES ($1, 'send-state-repo', 'Send State Repo', 'https://github.com/x/y.git', $2, NULL, true)
       ON CONFLICT (org_id, slug) DO UPDATE SET git_url = EXCLUDED.git_url RETURNING id`,
      [ORG_ID, BASE_BRANCH],
    );
    repoId = repoRows[0].id;
  });

  afterAll(async () => {
    await mod?.close();
  });

  beforeEach(async () => {
    notifier.emitMessagesChanged.mockClear();
    await ds.query(
      'TRUNCATE inbound_messages, transcript_messages, jobs RESTART IDENTITY CASCADE',
    );
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

  async function transcriptRows(jobId: string): Promise<TranscriptRow[]> {
    return ds.query(
      `SELECT id, text, stimulus_id, delivered_at, author_bot_id
         FROM transcript_messages WHERE job_id = $1 ORDER BY created_at ASC`,
      [jobId],
    );
  }

  async function inboundDeliveredAt(id: string): Promise<Date | null> {
    const rows = await ds.query(
      `SELECT delivered_at FROM inbound_messages WHERE id = $1`,
      [id],
    );
    return rows[0]?.delivered_at ?? null;
  }

  it('a composed note+answers send lands ONE correlated operator bubble (no pill) and emits once', async () => {
    const thread = await makeThread('composed send thread');
    const NOTE = 'thanks, that unblocks me!';
    const COMPOSED_BODY =
      '<system_notice>The operator answered q1.</system_notice>\n' +
      `<user name="Dennis">${NOTE}</user>`;

    const recorded = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: COMPOSED_BODY,
      operatorBubbleText: NOTE,
      seedQuestionIds: ['q1'],
      type: 'user',
    });

    // The delivery-ledger row carries the FULL composed turn — that is what the brain reads.
    const inbound = await ds.query(
      `SELECT body FROM inbound_messages WHERE id = $1`,
      [recorded.id],
    );
    expect(inbound[0].body).toBe(COMPOSED_BODY);

    // Exactly ONE transcript row: the operator bubble rendering ONLY the note (no "…+ a message" pill).
    const rows = await transcriptRows(thread.id);
    expect(rows).toHaveLength(1);
    const bubble = rows[0];
    expect(bubble.text).toBe(NOTE);
    expect(bubble.author_bot_id).toBeNull();
    // Correlated to its ledger row, and still "sending" (delivered_at NULL) at write time.
    expect(bubble.stimulus_id).toBe(recorded.id);
    expect(bubble.delivered_at).toBeNull();

    // Send-persist emitted the realtime nudge exactly once.
    expect(notifier.emitMessagesChanged).toHaveBeenCalledTimes(1);
    expect(notifier.emitMessagesChanged).toHaveBeenCalledWith(
      repoId,
      thread.id,
    );
  });

  it('markChatDelivered stamps BOTH ledger + correlated bubble, emits once, and is idempotent', async () => {
    const thread = await makeThread('delivery stamp thread');
    const NOTE = 'go ahead';

    const recorded = await store.recordChatStimulus({
      orgId: ORG_ID,
      repoId,
      jobId: thread.id,
      author: OPERATOR,
      replyRoute: { surfaceId: 'web', jobRef: thread.id },
      body: `<user name="Dennis">${NOTE}</user>`,
      operatorBubbleText: NOTE,
      type: 'user',
    });
    notifier.emitMessagesChanged.mockClear();

    await store.markChatDelivered(recorded.id);

    // BOTH rows stamped delivered.
    expect(await inboundDeliveredAt(recorded.id)).not.toBeNull();
    const afterDeliver = (await transcriptRows(thread.id))[0];
    expect(afterDeliver.delivered_at).not.toBeNull();
    expect(afterDeliver.stimulus_id).toBe(recorded.id);

    // Delivery-stamp emitted exactly once.
    expect(notifier.emitMessagesChanged).toHaveBeenCalledTimes(1);
    expect(notifier.emitMessagesChanged).toHaveBeenCalledWith(
      repoId,
      thread.id,
    );

    // Idempotent: a second call neither throws nor re-emits (already-delivered → no-op).
    await expect(store.markChatDelivered(recorded.id)).resolves.toBeUndefined();
    expect(notifier.emitMessagesChanged).toHaveBeenCalledTimes(1);
  });
});
