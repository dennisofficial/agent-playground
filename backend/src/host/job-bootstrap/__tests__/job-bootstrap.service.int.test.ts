import { Db } from '@workspace/nestjs-rls/nest';
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
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { InboundMessage } from '../../../_lib/database/entities/inbound-message.entity';
import { Job } from '../../../_lib/database/entities/job.entity';
import { Organization } from '../../../_lib/database/entities/organization.entity';
import { Repo } from '../../../_lib/database/entities/repo.entity';
import { Subagent } from '../../../_lib/database/entities/subagent.entity';
import { ThreadGroup } from '../../../_lib/database/entities/thread-group.entity';
import { ThreadMessage } from '../../../_lib/database/entities/thread-message.entity';
import { Thread } from '../../../_lib/database/entities/thread.entity';
import type { User } from '../../../_lib/database/entities/user.entity';
import { InboundMessageService } from '../../inbound-message/inbound-message.service';
import { JobBootstrapService } from '../job-bootstrap.service';
import { TurnFlowService } from '../turn-flow.service';

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

describe('JobBootstrapService (int)', () => {
  let ds: DataSource;
  let service: JobBootstrapService;
  let flow: { add: ReturnType<typeof vi.fn> };
  let orgId: string;
  let repoId: string;
  const claims = { userId: 'u1', orgIds: [] as string[], ownerOrgIds: [] as string[] };
  const user = { id: 'u1', name: 'Dennis', email: 'dennis@example.test' } as User;

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
    const db = new Db(ds, {
      resolveContext: async () => Promise.resolve(claims),
      resolveClaims: () => claims,
      exempt: () => false,
    });
    const inbound = new InboundMessageService(db, ds.getRepository(InboundMessage));
    flow = { add: vi.fn(async () => Promise.resolve({})) };
    const turnFlow = new TurnFlowService(flow as unknown as FlowProducer);
    service = new JobBootstrapService(db, inbound, turnFlow);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    flow.add.mockClear();
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
    repoId = repo.id;
    claims.orgIds = [orgId];
    claims.ownerOrgIds = [orgId];
  });

  it('creates the job + planning tree, enqueues one PENDING message + operator bubble, and adds the flow', async () => {
    const result = await service.create(
      { orgId, repoId, firstMessage: 'do the thing', title: 'My job', kind: EJobKind.FEATURE },
      user,
    );

    const job = await ds.getRepository(Job).findOneByOrFail({ id: result.jobId });
    expect(job.status).toBe(EJobStatus.OPEN);
    expect(job.origin).toBe(EThreadOrigin.CHAT);
    expect(job.kind).toBe(EJobKind.FEATURE);
    expect(job.title).toBe('My job');
    expect(job.focusedThreadId).toBe(result.focusedThreadId);

    const groups = await ds.getRepository(ThreadGroup).find({ where: { jobId: result.jobId } });
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe(EThreadGroupKind.PLANNING);
    expect(groups[0].ordinal).toBe(0);

    const threads = await ds.getRepository(Thread).find({ where: { jobId: result.jobId } });
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(result.focusedThreadId);
    expect(threads[0].role).toBe(EThreadRole.PLANNING);
    expect(threads[0].brief).toBe('Main');

    const inbound = await ds.getRepository(InboundMessage).find({ where: { jobId: result.jobId } });
    expect(inbound).toHaveLength(1);
    expect(inbound[0].status).toBe(EInboundMessageStatus.PENDING);
    expect(inbound[0].priority).toBe(EInboundPriority.NOW);
    expect(inbound[0].text).toBe('do the thing');
    expect(inbound[0].source).toBe(EThreadMessageSource.OPERATOR);

    const bubbles = await ds.getRepository(ThreadMessage).find({ where: { jobId: result.jobId } });
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0].source).toBe(EThreadMessageSource.OPERATOR);
    expect(bubbles[0].author).toBe('Dennis'); // display name lives on the bubble, not the inbound row

    // The flow is added with deterministic single-flight ids — a second add for the same jobId would
    // collide on these ids (BullMQ dedups), so a job can't run two concurrent flows.
    expect(flow.add).toHaveBeenCalledTimes(1);
    const added = flow.add.mock.calls[0][0];
    expect(added.opts.jobId).toBe(`dispatch-${result.jobId}`);
    expect(added.children[0].opts.jobId).toBe(`provision-${result.jobId}`);
  });

  it('rejects creating a job for a repo the caller cannot access', async () => {
    claims.orgIds = [];
    claims.ownerOrgIds = [];
    await expect(
      service.create({ orgId, repoId, firstMessage: 'nope' }, user),
    ).rejects.toBeTruthy();
    expect(flow.add).not.toHaveBeenCalled();
  });

  it('sendMessage enqueues a PENDING operator message on the focused thread and adds the flow', async () => {
    const { jobId, focusedThreadId } = await service.create(
      { orgId, repoId, firstMessage: 'start' },
      user,
    );
    flow.add.mockClear(); // ignore create's flow add — assert only sendMessage's

    const res = await service.sendMessage(jobId, user, {
      messages: [{ type: 'operator', text: 'and also this' }],
    });

    const inbound = await ds.getRepository(InboundMessage).find({ where: { jobId } });
    expect(inbound).toHaveLength(2); // create's trigger + this message
    const posted = inbound.find((r) => r.id === res.messageIds[0]);
    expect(posted).toBeDefined();
    expect(posted?.status).toBe(EInboundMessageStatus.PENDING);
    expect(posted?.priority).toBe(EInboundPriority.NOW);
    expect(posted?.source).toBe(EThreadMessageSource.OPERATOR);
    expect(posted?.threadId).toBe(focusedThreadId); // defaulted to the focused thread
    expect(posted?.text).toBe('and also this');

    // The visible bubble is written too (create's + this one).
    const bubbles = await ds.getRepository(ThreadMessage).find({ where: { jobId } });
    expect(bubbles).toHaveLength(2);

    expect(flow.add).toHaveBeenCalledTimes(1);
    expect(flow.add.mock.calls[0][0].opts.jobId).toBe(`dispatch-${jobId}`);
  });

  it('sendMessage persists one inbound row per typed item, with mapped source + payload', async () => {
    const { jobId } = await service.create({ orgId, repoId, firstMessage: 'start' }, user);
    flow.add.mockClear();

    const res = await service.sendMessage(jobId, user, {
      messages: [
        { type: 'operator', text: 'do X' },
        { type: 'answer_question', questionId: 'q1', answer: 'yes' },
      ],
    });

    expect(res.messageIds).toHaveLength(2);
    const rows = await ds.getRepository(InboundMessage).find({ where: { jobId } });
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
    const { jobId } = await service.create({ orgId, repoId, firstMessage: 'start' }, user);
    await ds.getRepository(Job).update({ id: jobId }, { archivedAt: new Date() });
    flow.add.mockClear();

    await expect(
      service.sendMessage(jobId, user, { messages: [{ type: 'operator', text: 'too late' }] }),
    ).rejects.toBeTruthy();
    expect(flow.add).not.toHaveBeenCalled();
  });
});
