import { EJobStatus, EThreadOrigin } from '@workspace/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { JobViewService } from '../job-view.service';
import { JobService } from '../job.service';
import { createScopedTestContext, type ScopedTestContext } from './pgbase-test-support';

describe('JobService.archive + archived read-exclusion (int)', () => {
  let ctx: ScopedTestContext;
  let service: JobService;
  let orgId: string;
  let jobId: string;

  beforeAll(async () => {
    ctx = await createScopedTestContext();
    const inbound = { discardPending: vi.fn(async () => {}) } as unknown as InboundMessageService;
    const sandbox = { teardown: vi.fn(async () => {}) } as unknown as SandboxService;
    service = new JobService(ctx.scopedDb, new JobViewService(), inbound, sandbox);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.prisma.$executeRawUnsafe(
      `TRUNCATE threads, thread_groups, jobs, repos, organizations RESTART IDENTITY CASCADE`,
    );
    const org = await ctx.prisma.organization.create({ data: { name: 'Org' } });
    orgId = org.id;
    const repo = await ctx.prisma.repo.create({
      data: { orgId, slug: 'o/r', name: 'r', gitUrl: 'https://example.test/o/r.git' },
    });
    const job = await ctx.prisma.job.create({
      data: { orgId, repoId: repo.id, origin: EThreadOrigin.CHAT },
    });
    jobId = job.id;
    ctx.claims.orgIds = [orgId];
    ctx.claims.ownerOrgIds = [orgId];
  });

  it('archive flips status + stamps archivedAt and returns the updated row', async () => {
    const result = await ctx.run(() => service.archive(jobId));
    expect(result.status).toBe(EJobStatus.ARCHIVED);
    expect(result.archivedAt).not.toBeNull();

    const row = await ctx.prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe(EJobStatus.ARCHIVED);
    expect(row.archivedAt).toBeInstanceOf(Date);
  });

  it('an archived job is no longer visible to scoped reads', async () => {
    expect(await ctx.run(() => service.list())).toHaveLength(1);

    await ctx.run(() => service.archive(jobId));

    expect(await ctx.run(() => service.list())).toHaveLength(0);
    await expect(ctx.run(() => service.assertAccess(jobId))).rejects.toThrow();
  });
});
