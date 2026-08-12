import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaBunSqlite } from 'prisma-adapter-bun-sqlite';
import { renderTaskList } from '../../domain/tasks.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import {
  EPhaseKind,
  ETaskStatus,
  EThreadRole,
} from '../../generated/prisma/enums.js';
import { MigratorService } from '../migrator.service.js';
import type { PrismaService } from '../prisma.service.js';
import { TaskRepository } from '../task.repository.js';

/**
 * A real temporary SQLite file, because both claims under test are claims about the DATABASE: that
 * numbering comes off the highest ordinal ever used, and that a missing number is a count of zero
 * rather than a throw. A fake client would only assert that the fake counts.
 */
describe('TaskRepository', () => {
  let dir: string;
  let client: PrismaClient;
  let taskRepository: TaskRepository;
  let threadId: string;
  let otherThreadId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-tasks-'));
    const database = join(dir, 'atlas.db');
    new MigratorService().migrate(database);

    client = new PrismaClient({ adapter: new PrismaBunSqlite({ url: `file:${database}` }) });
    taskRepository = new TaskRepository(client as unknown as PrismaService);

    const project = await client.project.create({ data: { path: dir, name: 'atlas' } });
    const job = await client.job.create({ data: { projectId: project.id, title: 'a job' } });
    const phase = await client.phase.create({
      data: { jobId: job.id, kind: EPhaseKind.build, ordinal: 0 },
    });
    const thread = await client.thread.create({
      data: { phaseId: phase.id, role: EThreadRole.builder },
    });
    const other = await client.thread.create({
      data: { phaseId: phase.id, role: EThreadRole.builder },
    });
    threadId = thread.id;
    otherThreadId = other.id;
  });

  afterEach(async () => {
    await client.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('numbers from one and appends without renumbering', async () => {
    await taskRepository.append({ threadId, texts: ['read the code', 'write the code'] });
    const tasks = await taskRepository.append({ threadId, texts: ['ship it'] });

    expect(tasks.map((task) => task.ordinal)).toEqual([1, 2, 3]);
    expect(tasks[2]).toEqual({ ordinal: 3, text: 'ship it', status: ETaskStatus.pending });
  });

  // The one way a render-only table could still corrupt a decision: recycling a number the agent
  // has already written down.
  it('never hands a deleted task’s number to a new one', async () => {
    await taskRepository.append({ threadId, texts: ['one', 'two'] });
    await taskRepository.setStatus({ threadId, ordinal: 2, status: ETaskStatus.deleted });

    const tasks = await taskRepository.append({ threadId, texts: ['three'] });
    expect(tasks.map((task) => task.ordinal)).toEqual([1, 2, 3]);
    expect(tasks[2]?.text).toBe('three');
  });

  /**
   * `deleted` is a STATUS, and both halves of that are claims about this layer: the row survives the
   * retirement (the store still has it), and the render is what drops it (the store does not filter).
   * A plan that silently loses entries reads as a plan that was never made.
   */
  it('keeps a retired task as a row, and leaves the hiding to the render', async () => {
    await taskRepository.append({ threadId, texts: ['one', 'two'] });
    await taskRepository.setStatus({ threadId, ordinal: 2, status: ETaskStatus.deleted });

    const stored = await taskRepository.listForThread(threadId);
    expect(stored).toHaveLength(2);
    expect(stored[1]).toEqual({ ordinal: 2, text: 'two', status: ETaskStatus.deleted });
    // …and the render is where it disappears.
    expect(renderTaskList(stored)).toBe('#1 [pending] one');
  });

  it('sets a status, and the text where one is given', async () => {
    await taskRepository.append({ threadId, texts: ['one'] });

    const started = await taskRepository.setStatus({
      threadId,
      ordinal: 1,
      status: ETaskStatus.in_progress,
    });
    expect(started?.[0]?.status).toBe(ETaskStatus.in_progress);
    expect(started?.[0]?.text).toBe('one');

    const renamed = await taskRepository.setStatus({
      threadId,
      ordinal: 1,
      status: ETaskStatus.completed,
      text: 'one, corrected',
    });
    expect(renamed?.[0]?.text).toBe('one, corrected');
  });

  // Never throws, at the layer where the miss actually happens.
  it('answers null for a number that does not exist', async () => {
    await taskRepository.append({ threadId, texts: ['one'] });
    expect(
      await taskRepository.setStatus({ threadId, ordinal: 7, status: ETaskStatus.completed }),
    ).toBeNull();
  });

  // Tasks hang off the THREAD, and numbering is per thread — two threads both start at #1.
  it('keeps one thread’s list out of another’s', async () => {
    await taskRepository.append({ threadId, texts: ['mine'] });
    const theirs = await taskRepository.append({ threadId: otherThreadId, texts: ['theirs'] });

    expect(theirs).toEqual([{ ordinal: 1, text: 'theirs', status: ETaskStatus.pending }]);
    expect(await taskRepository.listForThread(threadId)).toHaveLength(1);
    expect(
      await taskRepository.setStatus({
        threadId: otherThreadId,
        ordinal: 1,
        status: ETaskStatus.completed,
      }),
    ).not.toBeNull();
    expect((await taskRepository.listForThread(threadId))[0]?.status).toBe(ETaskStatus.pending);
  });

  // The cascade is the schema's, and it is what keeps a deleted job from leaving rows behind.
  it('goes with the thread it hangs off', async () => {
    await taskRepository.append({ threadId, texts: ['one'] });
    await client.thread.delete({ where: { id: threadId } });
    expect(await taskRepository.listForThread(threadId)).toHaveLength(0);
  });
});
