import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { PrismaClient } from '../../generated/prisma/client.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import { JobRepository } from '../job.repository.js';
import { MigratorService } from '../migrator.service.js';
import type { PrismaService } from '../prisma.service.js';
import { ThreadRepository } from '../thread.repository.js';

/**
 * Runs against a real (temporary) SQLite file rather than a fake client, because the claim under
 * test — "the current phase is the highest ordinal" — is a claim about an ORDER BY, and a fake
 * repository would only assert that the fake sorts.
 *
 * `PrismaService` is `PrismaClient` plus a hardcoded path to the user's real database and a Nest
 * lifecycle; the repositories use neither, so a bare client stands in for it.
 */
describe('JobRepository phases', () => {
  let dir: string;
  let client: PrismaClient;
  let jobRepository: JobRepository;
  let threadRepository: ThreadRepository;
  let projectId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-jobs-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    jobRepository = new JobRepository(prismaService);
    threadRepository = new ThreadRepository(prismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    projectId = project.id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a job with exactly one phase, at ordinal zero', async () => {
    const job = await jobRepository.create({
      projectId,
      title: 'a job',
      kind: EPhaseKind.charting,
    });

    const phases = await client.phase.findMany({ where: { jobId: job.id } });
    expect(phases).toHaveLength(1);
    expect(phases[0]?.kind).toBe(EPhaseKind.charting);
    expect(phases[0]?.ordinal).toBe(0);
  });

  it('resolves the current phase by highest ordinal, not by insertion order', async () => {
    const job = await jobRepository.create({
      projectId,
      title: 'a job',
      kind: EPhaseKind.charting,
    });
    const planning = await client.phase.create({
      data: { jobId: job.id, kind: EPhaseKind.planning, ordinal: 1 },
    });

    expect((await jobRepository.currentPhase(job.id)).id).toBe(planning.id);
  });

  it('distinguishes two phases of the SAME kind — a re-entered kind is a new phase', async () => {
    const job = await jobRepository.create({
      projectId,
      title: 'a job',
      kind: EPhaseKind.direct_build,
    });
    const second = await client.phase.create({
      data: { jobId: job.id, kind: EPhaseKind.direct_build, ordinal: 1 },
    });

    // The deleted `groupFor(jobId, kind)` would have returned the FIRST one here.
    expect((await jobRepository.currentPhase(job.id)).id).toBe(second.id);
  });

  it('treats a job with no phase as broken rather than empty', async () => {
    const job = await client.job.create({ data: { projectId, title: 'malformed' } });
    expect(jobRepository.currentPhase(job.id)).rejects.toThrow(/no phase/);
  });

  it('reports the phase kind on every thread it lists', async () => {
    const job = await jobRepository.create({
      projectId,
      title: 'a job',
      kind: EPhaseKind.charting,
    });
    const phase = await jobRepository.currentPhase(job.id);
    await threadRepository.create({ phaseId: phase.id, role: EThreadRole.charting });

    const threads = await threadRepository.listForJob(job.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.phaseKind).toBe(EPhaseKind.charting);
  });

  it('summarises a job from the phase its active thread sits in', async () => {
    const job = await jobRepository.create({
      projectId,
      title: 'a job',
      kind: EPhaseKind.charting,
    });
    const phase = await jobRepository.currentPhase(job.id);
    const thread = await threadRepository.create({
      phaseId: phase.id,
      role: EThreadRole.research,
    });
    await jobRepository.setActiveThread(job.id, thread.id);

    const [row] = await jobRepository.listForProject(projectId);
    expect(row?.activePhase).toBe(EPhaseKind.charting);
    expect(row?.activeRole).toBe(EThreadRole.research);
  });
});
