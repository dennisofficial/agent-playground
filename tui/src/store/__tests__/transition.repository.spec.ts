import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { PrismaClient } from '../../generated/prisma/client.js';
import {
  EPhaseKind,
  ETransitionScope,
  ETransitionSource,
  ETransitionStatus,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import { JobRepository } from '../job.repository.js';
import { MigratorService } from '../migrator.service.js';
import type { PrismaService } from '../prisma.service.js';
import { ThreadRepository } from '../thread.repository.js';
import { TransitionRepository } from '../transition.repository.js';

/**
 * Against a real (temporary) SQLite file rather than a fake client, because the claim under test is
 * that a proposal is a ROW: that it is still there when the process that raised it is gone, which a
 * fake repository could only ever assert about itself.
 */
describe('a proposal is a row', () => {
  let dir: string;
  let database: string;
  let client: PrismaClient;
  let transitions: TransitionRepository;
  let jobs: JobRepository;
  let threads: ThreadRepository;
  let jobId: string;
  let phaseId: string;
  let threadId: string;

  function connect(): PrismaClient {
    return new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-transitions-'));
    database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = connect();
    const prismaService = client as unknown as PrismaService;
    transitions = new TransitionRepository(prismaService);
    jobs = new JobRepository(prismaService);
    threads = new ThreadRepository(prismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    const job = await jobs.create({
      projectId: project.id,
      title: 'add avatar upload',
      kind: EPhaseKind.planning,
    });
    jobId = job.id;
    phaseId = (await jobs.currentPhase(jobId)).id;
    threadId = (await threads.create({ phaseId, role: EThreadRole.planner })).id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  async function raise(): Promise<string> {
    const raised = await transitions.raise({
      jobId,
      fromPhaseId: phaseId,
      raisedByThreadId: threadId,
      to: EPhaseKind.build,
      reason: 'the plan is written and reviewed',
      handoff: 'Slices are in specs/. I rejected a shared cache — invalidation is per-job.',
      attach: ['specs/plan.md'],
    });
    return raised.id;
  }

  it('survives the process that raised it', async () => {
    const id = await raise();
    await client.$disconnect();

    // A second connection is the closest a unit test gets to a restart: nothing is held in memory
    // across it, so what comes back is what is on disk.
    client = connect();
    const reopened = new TransitionRepository(client as unknown as PrismaService);

    const pending = await reopened.pendingForJob(jobId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(id);
    expect(pending[0]?.status).toBe(ETransitionStatus.pending);
    expect(pending[0]?.reason).toContain('the plan is written');
    expect(pending[0]?.handoff).toContain('rejected a shared cache');
    // Decoded off the Json column, so nothing above the store handles `Prisma.JsonValue`.
    expect(pending[0]?.attach).toEqual(['specs/plan.md']);
  });

  it('records who raised it, at what scope, and where it wants to go', async () => {
    const id = await raise();
    const found = await transitions.findById(id);

    expect(found?.raisedBy).toBe(ETransitionSource.agent);
    expect(found?.scope).toBe(ETransitionScope.phase);
    expect(found?.to).toBe(EPhaseKind.build);
    expect(found?.fromPhaseId).toBe(phaseId);
    expect(found?.raisedByThreadId).toBe(threadId);
  });

  it('nothing about the job moves when one is raised', async () => {
    await raise();

    // The whole point of the propose/confirm split: the row exists and the job is exactly where it
    // was. Confirmation is the only thing that appends a phase.
    expect(await jobs.listPhases(jobId)).toHaveLength(1);
    expect((await jobs.currentPhase(jobId)).kind).toBe(EPhaseKind.planning);
  });

  it('ties a confirmation to the phase it created, and drops it out of the pending query', async () => {
    const id = await raise();
    const phase = await jobs.appendPhase({ jobId, kind: EPhaseKind.build });

    await transitions.confirm({ id, createdPhaseId: phase.id });

    const found = await transitions.findById(id);
    expect(found?.status).toBe(ETransitionStatus.confirmed);
    expect(found?.createdPhaseId).toBe(phase.id);
    expect(found?.decidedAt).not.toBeNull();
    expect(await transitions.pendingForJob(jobId)).toHaveLength(0);
  });

  /**
   * The jobs list's query: one read for every project on the screen. It carries the proposing
   * THREAD as well as the job, because a job row's condition is the union of its threads' facts and
   * there is exactly one attention table in the app.
   */
  it('reports every pending proposal across jobs, with the thread that is waiting', async () => {
    const id = await raise();

    const other = await jobs.create({
      projectId: (await client.project.findFirstOrThrow()).id,
      title: 'a second job',
      kind: EPhaseKind.planning,
    });
    const otherThread = await threads.create({
      phaseId: (await jobs.currentPhase(other.id)).id,
      role: EThreadRole.planner,
    });
    const second = await transitions.raise({
      jobId: other.id,
      fromPhaseId: (await jobs.currentPhase(other.id)).id,
      raisedByThreadId: otherThread.id,
      to: EPhaseKind.build,
      reason: 'ready',
      handoff: 'go',
      attach: [],
    });

    expect(await transitions.pendingProposals()).toEqual([
      { id, jobId, raisedByThreadId: threadId },
      { id: second.id, jobId: other.id, raisedByThreadId: otherThread.id },
    ]);

    // Answered rows leave the signal the moment they are answered — the list says `confirm` for
    // exactly as long as a keypress is owed.
    await transitions.decline({ id });
    expect(await transitions.pendingProposals()).toHaveLength(1);
  });

  it('KEEPS a decline, with its reason — that is the data that says a trigger is mistuned', async () => {
    const id = await raise();

    await transitions.decline({ id, reason: 'the plan misses the migration' });

    const found = await transitions.findById(id);
    expect(found?.status).toBe(ETransitionStatus.declined);
    expect(found?.declineReason).toBe('the plan misses the migration');
    expect(found?.createdPhaseId).toBeNull();
    expect(await transitions.pendingForJob(jobId)).toHaveLength(0);
  });
});

describe('phases as an append-only log', () => {
  let dir: string;
  let client: PrismaClient;
  let jobs: JobRepository;
  let threads: ThreadRepository;
  let jobId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-phases-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);
    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    const prismaService = client as unknown as PrismaService;
    jobs = new JobRepository(prismaService);
    threads = new ThreadRepository(prismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    jobId = (
      await jobs.create({ projectId: project.id, title: 'a job', kind: EPhaseKind.planning })
    ).id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends at the next ordinal and becomes the current phase', async () => {
    const appended = await jobs.appendPhase({ jobId, kind: EPhaseKind.build });

    expect(appended.ordinal).toBe(1);
    expect((await jobs.currentPhase(jobId)).id).toBe(appended.id);
    expect(await jobs.listPhases(jobId)).toHaveLength(2);
  });

  it('appends a REPEATED kind as a new phase rather than reopening the old one', async () => {
    const first = await jobs.appendPhase({ jobId, kind: EPhaseKind.direct_build });
    await jobs.appendPhase({ jobId, kind: EPhaseKind.ci });
    const second = await jobs.appendPhase({ jobId, kind: EPhaseKind.direct_build });

    // A second `direct_build` chasing a red build is a new phase. Phases never reopen.
    expect(second.id).not.toBe(first.id);
    expect(second.ordinal).toBe(3);
  });

  it('counts only the threads still open in a phase', async () => {
    const phaseId = (await jobs.currentPhase(jobId)).id;
    const first = await threads.create({ phaseId, role: EThreadRole.planner });
    const second = await threads.create({ phaseId, role: EThreadRole.research });
    const elsewhere = await jobs.appendPhase({ jobId, kind: EPhaseKind.build });
    await threads.create({ phaseId: elsewhere.id, role: EThreadRole.builder });

    await threads.close(second.id);

    // Scoped to the phase, not the job: a thread in another phase says nothing about whether THIS
    // one is finished.
    expect(await jobs.openThreadIdsInPhase(phaseId)).toEqual([first.id]);
  });
});
