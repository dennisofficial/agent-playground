import { Db } from '@workspace/nestjs-rls/nest';
import {
  EInboundMessageStatus,
  EInboundPriority,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
} from '@workspace/shared';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { InboundMessage } from '../../../_lib/database/entities/inbound-message.entity';
import { Job } from '../../../_lib/database/entities/job.entity';
import { Organization } from '../../../_lib/database/entities/organization.entity';
import { Repo } from '../../../_lib/database/entities/repo.entity';
import { Subagent } from '../../../_lib/database/entities/subagent.entity';
import { ThreadGroup } from '../../../_lib/database/entities/thread-group.entity';
import { ThreadMessage } from '../../../_lib/database/entities/thread-message.entity';
import { Thread } from '../../../_lib/database/entities/thread.entity';
import { InboundMessageService } from '../inbound-message.service';

const ENTITIES = [
  Organization,
  Repo,
  Job,
  ThreadGroup,
  Thread,
  ThreadMessage,
  Subagent,
  InboundMessage,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// System-actor ctx: this service writes/reads through `db.unsafe`, so the claims are never consulted.
const SYSTEM_CTX = {
  resolveContext: async () => Promise.resolve({ userId: null, orgIds: [], ownerOrgIds: [] }),
  resolveClaims: () => ({ userId: null, orgIds: [], ownerOrgIds: [] }),
  exempt: () => true,
};

describe('InboundMessageService (int)', () => {
  let ds: DataSource;
  let service: InboundMessageService;
  let orgId: string;
  let jobId: string;
  let threadId: string;

  beforeAll(async () => {
    ds = await new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: ENTITIES,
      synchronize: false,
      namingStrategy: new CustomNamingStrategy(),
    }).initialize();
    const db = new Db(ds, SYSTEM_CTX);
    service = new InboundMessageService(db, ds.getRepository(InboundMessage));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(
      `TRUNCATE inbound_messages, thread_messages, threads, thread_groups, jobs, repos, organizations RESTART IDENTITY CASCADE`,
    );
    const org = await ds.getRepository(Organization).save({ name: 'Org' });
    orgId = org.id;
    const repo = await ds.getRepository(Repo).save({
      orgId,
      slug: 'o/r',
      name: 'r',
      gitUrl: 'https://example.test/o/r.git',
    });
    const job = await ds
      .getRepository(Job)
      .save({ orgId, repoId: repo.id, origin: EThreadOrigin.CHAT });
    jobId = job.id;
    const group = await ds.getRepository(ThreadGroup).save({
      jobId,
      orgId,
      ordinal: 0,
      kind: EThreadGroupKind.PLANNING,
      status: EThreadStatus.PENDING,
    });
    const thread = await ds.getRepository(Thread).save({
      jobId,
      threadGroupId: group.id,
      orgId,
      role: EThreadRole.PLANNING,
      type: EThreadType.GENERAL,
      ordinal: 0,
      brief: 'Main',
      status: EThreadStatus.PENDING,
    });
    threadId = thread.id;
  });

  function base(text: string, priority: EInboundPriority) {
    return {
      jobId,
      threadId,
      orgId,
      authorId: 'u1',
      author: 'Operator',
      source: EThreadMessageSource.OPERATOR,
      text,
      priority,
    };
  }

  it('enqueue writes one PENDING inbound row and one operator ThreadMessage', async () => {
    const row = await service.enqueue(base('hello', EInboundPriority.NOW));
    expect(row.status).toBe(EInboundMessageStatus.PENDING);

    const inbound = await ds.getRepository(InboundMessage).find({ where: { jobId } });
    expect(inbound).toHaveLength(1);

    const bubbles = await ds.getRepository(ThreadMessage).find({ where: { jobId } });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].source).toBe(EThreadMessageSource.OPERATOR);
    expect(bubbles[0].text).toBe('hello');
  });

  it('claimPending returns PENDING rows in FIFO order', async () => {
    await service.enqueue(base('first', EInboundPriority.NOW));
    await sleep(5);
    await service.enqueue(base('second', EInboundPriority.QUEUED));

    const claimed = await service.claimPending(jobId);
    expect(claimed.map((m) => m.text)).toEqual(['first', 'second']);
  });

  it('a lone `later` row is not claimed, but rides along once a `now`/`queued` exists', async () => {
    await service.enqueue(base('later-only', EInboundPriority.LATER));
    expect(await service.claimPending(jobId)).toEqual([]);
    expect(await service.hasPending(jobId)).toBe(false);

    await sleep(5);
    await service.enqueue(base('the-trigger', EInboundPriority.NOW));

    const claimed = await service.claimPending(jobId);
    expect(claimed.map((m) => m.text)).toEqual(['later-only', 'the-trigger']);
    expect(await service.hasPending(jobId)).toBe(true);
  });

  it('markDelivered flips rows to DELIVERED and stamps deliveredAt', async () => {
    const row = await service.enqueue(base('deliver-me', EInboundPriority.NOW));
    expect(await service.hasPending(jobId)).toBe(true);

    await service.markDelivered([row.id]);

    const after = await ds.getRepository(InboundMessage).findOneByOrFail({ id: row.id });
    expect(after.status).toBe(EInboundMessageStatus.DELIVERED);
    expect(after.deliveredAt).toBeInstanceOf(Date);
    expect(await service.hasPending(jobId)).toBe(false);
    expect(await service.claimPending(jobId)).toEqual([]);
  });

  it('pendingExcluding returns PENDING arrivals not in the exclude set (a running turn steers these)', async () => {
    const a = await service.enqueue(base('a', EInboundPriority.NOW)); // the turn's own trigger
    await sleep(5);
    const b = await service.enqueue(base('b', EInboundPriority.NOW)); // arrived mid-turn

    const fresh = await service.pendingExcluding(jobId, new Set([a.id]));
    expect(fresh.map((m) => m.id)).toEqual([b.id]);

    // Delivered rows never come back — after steering `b`, only the still-pending `a` remains.
    await service.markDelivered([b.id]);
    const remaining = await service.pendingExcluding(jobId, new Set());
    expect(remaining.map((m) => m.id)).toEqual([a.id]);
  });
});
