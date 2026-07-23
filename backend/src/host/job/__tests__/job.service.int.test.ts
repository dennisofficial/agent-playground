import { Db } from '@workspace/nestjs-rls/nest';
import { EJobStatus, EThreadOrigin } from '@workspace/shared';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomNamingStrategy } from '../../../_lib/database/custom-naming.strategy';
import { Job } from '../../../_lib/database/entities/job.entity';
import { Organization } from '../../../_lib/database/entities/organization.entity';
import { Repo } from '../../../_lib/database/entities/repo.entity';
import { ThreadGroup } from '../../../_lib/database/entities/thread-group.entity';
import { Thread } from '../../../_lib/database/entities/thread.entity';
import type { InboundMessageService } from '../../inbound-message/inbound-message.service';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { JobViewService } from '../job-view.service';
import { JobService } from '../job.service';

const ENTITIES = [Organization, Repo, Job, ThreadGroup, Thread];

describe('JobService.archive + archived read-exclusion (int)', () => {
  let ds: DataSource;
  let service: JobService;
  let orgId: string;
  let jobId: string;
  const claims = { userId: 'u1', orgIds: [] as string[], ownerOrgIds: [] as string[] };

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
      resolveContext: async () => claims,
      resolveClaims: () => claims,
      exempt: () => false,
    });
    const inbound = { discardPending: vi.fn(async () => {}) } as unknown as InboundMessageService;
    const sandbox = { teardown: vi.fn(async () => {}) } as unknown as SandboxService;
    service = new JobService(
      db,
      ds.getRepository(ThreadGroup),
      ds.getRepository(Thread),
      new JobViewService(),
      inbound,
      sandbox,
    );
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query(
      `TRUNCATE threads, thread_groups, jobs, repos, organizations RESTART IDENTITY CASCADE`,
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
    claims.orgIds = [orgId];
    claims.ownerOrgIds = [orgId];
  });

  it('archive flips status + stamps archivedAt and returns the updated row', async () => {
    const result = await service.archive(jobId);
    expect(result.status).toBe(EJobStatus.ARCHIVED);
    expect(result.archivedAt).not.toBeNull();

    const row = await ds.getRepository(Job).findOneByOrFail({ id: jobId });
    expect(row.status).toBe(EJobStatus.ARCHIVED);
    expect(row.archivedAt).toBeInstanceOf(Date);
  });

  it('an archived job is no longer visible to scoped reads', async () => {
    expect(await service.list()).toHaveLength(1);

    await service.archive(jobId);

    expect(await service.list()).toHaveLength(0);
    await expect(service.assertAccess(jobId)).rejects.toThrow();
  });
});
