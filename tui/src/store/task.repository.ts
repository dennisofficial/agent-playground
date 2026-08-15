import { Injectable } from '@nestjs/common';
import {
  carriedTasks,
  nextOrdinal,
  type CarriedTasks,
  type TaskView,
} from '../domain/tasks.js';
import type { ETaskStatus } from '../generated/prisma/enums.js';
import { PrismaService } from './prisma.service.js';

/**
 * The agent's plan, stored so the screen can draw it — and for nothing else.
 *
 * Tasks hang off the THREAD, the same level as messages and for the same reason: a session rotation
 * mints a new session, not a new thread, so the list survives the leg that wrote it with nothing to
 * stitch. Every method returns the WHOLE list because every caller renders the whole list; there is
 * no single-task getter because there is no detail view to open one in.
 */
@Injectable()
export class TaskRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async listForThread(threadId: string): Promise<TaskView[]> {
    const rows = await this.prismaService.task.findMany({
      where: { threadId },
      orderBy: { ordinal: 'asc' },
      select: { ordinal: true, text: true, status: true },
    });
    return rows.map((row) => ({ ...row }));
  }

  /**
   * Append, keeping the numbers the agent has already written down.
   *
   * Read-then-write over `ordinal`, like `MessageRepository.append` — safe for the same reason, that
   * one thread's turns are serialised onto a single lane. Numbers come off the highest ever used
   * rather than off the count, so a deleted row never hands its number to a different task.
   */
  async append(args: {
    threadId: string;
    texts: readonly string[];
  }): Promise<TaskView[]> {
    const existing = await this.listForThread(args.threadId);
    let ordinal = nextOrdinal(existing);
    await this.prismaService.task.createMany({
      data: args.texts.map((text) => ({
        threadId: args.threadId,
        ordinal: ordinal++,
        text,
      })),
    });
    return this.listForThread(args.threadId);
  }

  /**
   * Copy the tasks an outgoing agent NAMED onto its successor — `advance_thread`'s half of the list.
   *
   * Rows, not a reference: `carriedTasks` renumbers from 1 so the successor owns every number it can
   * see, and `setStatus` keys on `[threadId, ordinal]` and would otherwise be updating history. The
   * successor is newly opened and its list is empty, so this appends into nothing and needs none of
   * `append`'s read-then-write over the high-water mark.
   */
  async carryForward(args: {
    fromThreadId: string;
    toThreadId: string;
    declared: readonly number[];
  }): Promise<CarriedTasks> {
    const resolved = carriedTasks({
      tasks: await this.listForThread(args.fromThreadId),
      declared: args.declared,
    });
    if (resolved.carried.length === 0) return resolved;
    await this.prismaService.task.createMany({
      data: resolved.carried.map((task) => ({
        threadId: args.toThreadId,
        ordinal: task.ordinal,
        text: task.text,
        status: task.status,
      })),
    });
    return resolved;
  }

  /**
   * Set one task's status, and its text where the agent corrected it. Resolves `null` when there is
   * no such number — the caller turns that into a sentence, because a task list that can fail a turn
   * is worse than one that is briefly wrong.
   *
   * `updateMany` rather than `update`: `[threadId, ordinal]` is an index, not a unique key, so there
   * is no compound `where` to update by — and a miss must be a count of zero rather than a throw.
   */
  async setStatus(args: {
    threadId: string;
    ordinal: number;
    status: ETaskStatus;
    text?: string;
  }): Promise<TaskView[] | null> {
    const { count } = await this.prismaService.task.updateMany({
      where: { threadId: args.threadId, ordinal: args.ordinal },
      data: {
        status: args.status,
        ...(args.text === undefined ? {} : { text: args.text }),
      },
    });
    if (count === 0) return null;
    return this.listForThread(args.threadId);
  }
}
