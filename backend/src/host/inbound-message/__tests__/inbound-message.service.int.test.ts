import type { PrismaService } from '@lib/prisma/prisma.service';
import { PrismaPg } from '@prisma/adapter-pg';
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../../generated/prisma/client';
import { InboundMessageService } from '../inbound-message.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connectionString(): string {
  const user = encodeURIComponent(process.env.POSTGRES_USER ?? '');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '');
  const host = process.env.POSTGRES_HOST;
  const port = process.env.POSTGRES_PORT ?? '5432';
  const database = process.env.POSTGRES_DB;
  return `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=disable`;
}

// This service runs entirely through `PrismaService` (no caller to scope to — see the class docstring),
// so the int test exercises it against a plain, unscoped Prisma client.
describe('InboundMessageService (int)', () => {
  let prisma: PrismaClient;
  let service: InboundMessageService;
  let orgId: string;
  let jobId: string;
  let threadId: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });
    await prisma.$connect();
    service = new InboundMessageService(prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `TRUNCATE inbound_messages, thread_messages, threads, thread_groups, jobs, repos, organizations RESTART IDENTITY CASCADE`,
    );
    const org = await prisma.organization.create({ data: { name: 'Org' } });
    orgId = org.id;
    const repo = await prisma.repo.create({
      data: { orgId, slug: 'o/r', name: 'r', gitUrl: 'https://example.test/o/r.git' },
    });
    const job = await prisma.job.create({
      data: { orgId, repoId: repo.id, origin: EThreadOrigin.CHAT },
    });
    jobId = job.id;
    const group = await prisma.threadGroup.create({
      data: {
        jobId,
        orgId,
        ordinal: 0,
        kind: EThreadGroupKind.PLANNING,
        status: EThreadStatus.PENDING,
      },
    });
    const thread = await prisma.thread.create({
      data: {
        jobId,
        threadGroupId: group.id,
        orgId,
        role: EThreadRole.PLANNING,
        type: EThreadType.GENERAL,
        ordinal: 0,
        brief: 'Main',
        status: EThreadStatus.PENDING,
      },
    });
    threadId = thread.id;
  });

  function base(text: string, priority: EInboundPriority) {
    return {
      jobId,
      threadId,
      orgId,
      authorId: 'u1',
      source: EThreadMessageSource.OPERATOR,
      text,
      priority,
    };
  }

  it('enqueue writes ONLY the PENDING inbound row (no bubble yet)', async () => {
    const row = await service.enqueue(base('hello', EInboundPriority.NOW));
    expect(row.status).toBe(EInboundMessageStatus.PENDING);

    const inbound = await prisma.inboundMessage.findMany({ where: { jobId } });
    expect(inbound).toHaveLength(1);

    // The visible bubble is deferred to consume() — nothing in thread_messages at enqueue time.
    const bubbles = await prisma.threadMessage.findMany({ where: { jobId } });
    expect(bubbles).toHaveLength(0);
  });

  it('consume writes the operator bubble and flips the row to CONSUMED', async () => {
    const row = await service.enqueue(base('hello', EInboundPriority.NOW));

    await service.consume(row);

    const after = await prisma.inboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(EInboundMessageStatus.CONSUMED);

    const bubbles = await prisma.threadMessage.findMany({ where: { jobId } });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].source).toBe(EThreadMessageSource.OPERATOR);
    expect(bubbles[0].text).toBe('hello');
    expect(bubbles[0].authorId).toBe('u1');
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

  it('pendingExcluding returns PENDING arrivals not in the exclude set (a running turn steers these)', async () => {
    const a = await service.enqueue(base('a', EInboundPriority.NOW)); // the turn's own trigger
    await sleep(5);
    const b = await service.enqueue(base('b', EInboundPriority.NOW)); // arrived mid-turn

    const fresh = await service.pendingExcluding(jobId, new Set([a.id]));
    expect(fresh.map((m) => m.id)).toEqual([b.id]);

    // Consumed rows never come back — after the model incorporates `b`, only the still-pending `a` remains.
    await service.consume(b);
    const remaining = await service.pendingExcluding(jobId, new Set());
    expect(remaining.map((m) => m.id)).toEqual([a.id]);
  });
});
