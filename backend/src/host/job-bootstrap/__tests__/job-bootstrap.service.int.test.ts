import type { PrismaService } from '@lib/prisma/prisma.service';
import {
  EInboundMessageStatus,
  EInboundPriority,
  EJobKind,
  EJobStatus,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
} from '@workspace/shared';
import type { FlowProducer } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createScopedTestContext,
  type ScopedTestContext,
} from '../../job/__tests__/pgbase-test-support';
import { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { User } from '../../../_lib/database/entities/user.entity';
import { IntakeService } from '../intake.service';
import { JobBootstrapService } from '../job-bootstrap.service';
import { TurnFlowService } from '../turn-flow.service';

describe('JobBootstrapService (int)', () => {
  let ctx: ScopedTestContext;
  let service: JobBootstrapService;
  let flow: { add: ReturnType<typeof vi.fn> };
  let orgId: string;
  let repoId: string;
  const user = { id: 'u1', name: 'Dennis', email: 'dennis@example.test' } as User;

  beforeAll(async () => {
    ctx = await createScopedTestContext();
    const prismaService = ctx.prisma as unknown as PrismaService;
    const inbound = new InboundMessageService(prismaService);
    flow = { add: vi.fn(async () => Promise.resolve({})) };
    const turnFlow = new TurnFlowService(flow as unknown as FlowProducer);
    const intake = new IntakeService(prismaService, inbound, turnFlow);
    service = new JobBootstrapService(ctx.scopedDb, prismaService, intake);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    flow.add.mockClear();
    await ctx.prisma.$executeRawUnsafe(
      `TRUNCATE inbound_messages, thread_messages, threads, thread_groups, jobs, repos, organizations RESTART IDENTITY CASCADE`,
    );
    const org = await ctx.prisma.organization.create({ data: { name: 'Org' } });
    orgId = org.id;
    const repo = await ctx.prisma.repo.create({
      data: { orgId, slug: 'o/r', name: 'r', gitUrl: 'https://example.test/o/r.git' },
    });
    repoId = repo.id;
    ctx.claims.orgIds = [orgId];
    ctx.claims.ownerOrgIds = [orgId];
  });

  it('creates the job + planning tree, enqueues one PENDING message, and adds the flow', async () => {
    const result = await ctx.run(() =>
      service.create(
        { orgId, repoId, firstMessage: 'do the thing', title: 'My job', kind: EJobKind.FEATURE },
        user,
      ),
    );

    const job = await ctx.prisma.job.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(job.status).toBe(EJobStatus.OPEN);
    expect(job.origin).toBe(EThreadOrigin.CHAT);
    expect(job.kind).toBe(EJobKind.FEATURE);
    expect(job.title).toBe('My job');
    expect(job.focusedThreadId).toBe(result.focusedThreadId);

    const groups = await ctx.prisma.threadGroup.findMany({ where: { jobId: result.jobId } });
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe(EThreadGroupKind.PLANNING);
    expect(groups[0].ordinal).toBe(0);

    const threads = await ctx.prisma.thread.findMany({ where: { jobId: result.jobId } });
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(result.focusedThreadId);
    expect(threads[0].role).toBe(EThreadRole.PLANNING);
    expect(threads[0].brief).toBe('Main');

    const inbound = await ctx.prisma.inboundMessage.findMany({ where: { jobId: result.jobId } });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].status).toBe(EInboundMessageStatus.PENDING);
    expect(inbound[0].priority).toBe(EInboundPriority.NOW);
    expect(inbound[0].text).toBe('do the thing');
    expect(inbound[0].source).toBe(EThreadMessageSource.OPERATOR);

    // No bubble at enqueue time — the visible thread_messages row is written later, at consumption.
    const bubbles = await ctx.prisma.threadMessage.findMany({ where: { jobId: result.jobId } });
    expect(bubbles).toHaveLength(0);

    // The flow is added with deterministic single-flight ids — a second add for the same jobId would
    // collide on these ids (BullMQ dedups), so a job can't run two concurrent flows.
    expect(flow.add).toHaveBeenCalledTimes(1);
    const added = flow.add.mock.calls[0][0];
    expect(added.opts.jobId).toBe(`dispatch-${result.jobId}`);
    expect(added.children[0].opts.jobId).toBe(`provision-${result.jobId}`);
  });

  it('rejects creating a job for a repo the caller cannot access', async () => {
    ctx.claims.orgIds = [];
    ctx.claims.ownerOrgIds = [];
    await expect(
      ctx.run(() => service.create({ orgId, repoId, firstMessage: 'nope' }, user)),
    ).rejects.toBeTruthy();
    expect(flow.add).not.toHaveBeenCalled();
  });

  it('sendMessage enqueues a PENDING operator message on the focused thread and adds the flow', async () => {
    const { jobId, focusedThreadId } = await ctx.run(() =>
      service.create({ orgId, repoId, firstMessage: 'start' }, user),
    );
    flow.add.mockClear(); // ignore create's flow add — assert only sendMessage's

    const res = await ctx.run(() =>
      service.sendMessage(jobId, user, {
        messages: [{ type: 'operator', text: 'and also this' }],
      }),
    );

    const inbound = await ctx.prisma.inboundMessage.findMany({ where: { jobId } });
    expect(inbound).toHaveLength(2); // create's trigger + this message
    const posted = inbound.find((r) => r.id === res.messageIds[0]);
    expect(posted).toBeDefined();
    expect(posted?.status).toBe(EInboundMessageStatus.PENDING);
    expect(posted?.priority).toBe(EInboundPriority.NOW);
    expect(posted?.source).toBe(EThreadMessageSource.OPERATOR);
    expect(posted?.threadId).toBe(focusedThreadId); // defaulted to the focused thread
    expect(posted?.text).toBe('and also this');

    // Still no bubbles — those are written at consumption, not enqueue.
    const bubbles = await ctx.prisma.threadMessage.findMany({ where: { jobId } });
    expect(bubbles).toHaveLength(0);

    expect(flow.add).toHaveBeenCalledTimes(1);
    expect(flow.add.mock.calls[0][0].opts.jobId).toBe(`dispatch-${jobId}`);
  });

  it('sendMessage persists one inbound row per typed item, with mapped source + payload', async () => {
    const { jobId } = await ctx.run(() =>
      service.create({ orgId, repoId, firstMessage: 'start' }, user),
    );
    flow.add.mockClear();

    const res = await ctx.run(() =>
      service.sendMessage(jobId, user, {
        messages: [
          { type: 'operator', text: 'do X' },
          { type: 'answer_question', questionId: 'q1', answer: 'yes' },
        ],
      }),
    );

    expect(res.messageIds).toHaveLength(2);
    const rows = await ctx.prisma.inboundMessage.findMany({ where: { jobId } });
    const posted = rows.filter((r) => res.messageIds.includes(r.id));
    const op = posted.find((r) => (r.payload as { type?: string } | null)?.type === 'operator');
    const ans = posted.find(
      (r) => (r.payload as { type?: string } | null)?.type === 'answer_question',
    );
    expect(op?.text).toBe('do X');
    expect(op?.source).toBe(EThreadMessageSource.OPERATOR);
    expect(ans?.text).toBe('yes');
    expect((ans?.payload as { questionId?: string } | null)?.questionId).toBe('q1');

    // A batch is ONE turn trigger — the flow is added once, not per item.
    expect(flow.add).toHaveBeenCalledTimes(1);
  });

  it('sendMessage rejects an archived job and does not add a flow', async () => {
    const { jobId } = await ctx.run(() =>
      service.create({ orgId, repoId, firstMessage: 'start' }, user),
    );
    await ctx.prisma.job.update({ where: { id: jobId }, data: { archivedAt: new Date() } });
    flow.add.mockClear();

    await expect(
      ctx.run(() =>
        service.sendMessage(jobId, user, { messages: [{ type: 'operator', text: 'too late' }] }),
      ),
    ).rejects.toBeTruthy();
    expect(flow.add).not.toHaveBeenCalled();
  });
});
