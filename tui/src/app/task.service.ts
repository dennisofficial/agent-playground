import { Injectable, Logger } from '@nestjs/common';
import {
  carriedTaskSection,
  renderTaskList,
  taskCreatedReply,
  taskListSection,
  taskUpdatedReply,
  unknownTaskReply,
  type TaskView,
} from '../domain/tasks.js';
import type { ETaskStatus } from '../generated/prisma/enums.js';
import { TaskRepository } from '../store/task.repository.js';
import type { TaskActions } from './tools/tool.js';

/**
 * The task list, on both sides at once: the three tools the agent calls, and the read the checklist
 * draws itself from.
 *
 * **Nothing here throws.** Every method answers with a sentence the agent can act on — an unknown
 * number, a database that was busy — because the list exists for the render and a render that can
 * fail a turn is worse than one that is briefly wrong. That decision lives HERE rather than in each
 * tool so that the three tools cannot disagree about it.
 */
@Injectable()
export class TaskService implements TaskActions {
  private readonly logger = new Logger(TaskService.name);

  constructor(private readonly taskRepository: TaskRepository) {}

  /** What the checklist renders. Rows, not prose — the screen has its own shaping in `domain/`. */
  async rows(threadId: string): Promise<TaskView[]> {
    try {
      return await this.taskRepository.listForThread(threadId);
    } catch (error) {
      // A panel that vanishes is a better failure than a page that unmounts.
      this.logger.error(`task rows failed: ${String(error)}`);
      return [];
    }
  }

  /**
   * The list as a hand-off section, for the seed a ROTATION carries — same thread, live numbers.
   *
   * Empty string when there is nothing to carry, so a caller can append it unconditionally.
   */
  async section(threadId: string): Promise<string> {
    return taskListSection(await this.rows(threadId));
  }

  /**
   * `advance_thread`'s half: copy the named tasks onto the successor and render them for the seed.
   *
   * One call rather than a copy and a read, because the two must not be able to disagree — what the
   * successor is TOLD it has is exactly the rows that were written for it.
   *
   * Swallows its failure like everything else here. A hand-off that aborted because the checklist
   * could not be copied would cost the thread boundary itself, which is far more than the panel is
   * worth; the successor simply starts with an empty list and the hand-off prose still names the
   * work.
   */
  async carryForward(args: {
    fromThreadId: string;
    toThreadId: string;
    declared: readonly number[];
  }): Promise<{ carried: TaskView[]; ignored: number[]; section: string }> {
    try {
      const resolved = await this.taskRepository.carryForward(args);
      return { ...resolved, section: carriedTaskSection(resolved.carried) };
    } catch (error) {
      this.logger.error(`task carry-forward failed: ${String(error)}`);
      return { carried: [], ignored: [], section: '' };
    }
  }

  async create(args: {
    threadId: string;
    texts: readonly string[];
  }): Promise<string> {
    const texts = args.texts.map((text) => text.trim()).filter((text) => text.length > 0);
    if (texts.length === 0) return renderTaskList(await this.rows(args.threadId));
    try {
      const tasks = await this.taskRepository.append({
        threadId: args.threadId,
        texts,
      });
      return taskCreatedReply({ added: texts.length, tasks });
    } catch (error) {
      return this.failed({ verb: 'task_create', error });
    }
  }

  async update(args: {
    threadId: string;
    ordinal: number;
    status: ETaskStatus;
    text?: string;
  }): Promise<string> {
    try {
      const tasks = await this.taskRepository.setStatus(args);
      if (!tasks) return unknownTaskReply(args.ordinal);
      return taskUpdatedReply({ ordinal: args.ordinal, status: args.status, tasks });
    } catch (error) {
      return this.failed({ verb: 'task_update', error });
    }
  }

  async list(args: { threadId: string }): Promise<string> {
    return renderTaskList(await this.rows(args.threadId));
  }

  /**
   * The store failed. The agent is told plainly and told to carry on: it must not spend the rest of
   * its turn diagnosing Atlas's database, and the work it was doing is not affected by a checklist
   * that did not update.
   */
  private failed(args: { verb: string; error: unknown }): string {
    const detail = args.error instanceof Error ? args.error.message : String(args.error);
    this.logger.error(`${args.verb} failed: ${detail}`);
    return `${args.verb} did not take effect (${detail}). Carry on — the list is a render, not a gate.`;
  }
}
