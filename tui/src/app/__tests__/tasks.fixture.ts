import type { TaskView } from '../../domain/tasks.js';
import { ETaskStatus } from '../../generated/prisma/enums.js';
import type { TaskRepository } from '../../store/task.repository.js';
import { TaskService } from '../task.service.js';

/**
 * The task list, in memory, with the repository's exact semantics — including the one that matters:
 * **a miss is `null`, not a throw.** Shared because `ThreadSeamService` now takes a `TaskService`,
 * so every seam fixture needs one whether or not the test cares about tasks.
 */
export function fakeTaskRepository(seed: readonly TaskView[] = []): TaskRepository {
  const tasks = seed.map((task) => ({ ...task }));
  return {
    listForThread: async () => tasks.map((task) => ({ ...task })),
    append: async (args: { threadId: string; texts: readonly string[] }) => {
      // Off the highest ever used, never the count — a retired number is never reissued.
      let ordinal = tasks.reduce((high, task) => Math.max(high, task.ordinal), 0) + 1;
      for (const text of args.texts) {
        tasks.push({ ordinal: ordinal++, text, status: ETaskStatus.pending });
      }
      return tasks.map((task) => ({ ...task }));
    },
    setStatus: async (args: { ordinal: number; status: ETaskStatus; text?: string }) => {
      const found = tasks.find((task) => task.ordinal === args.ordinal);
      if (!found) return null;
      found.status = args.status;
      if (args.text !== undefined) found.text = args.text;
      return tasks.map((task) => ({ ...task }));
    },
  } as unknown as TaskRepository;
}

/** A seam fixture's eighth constructor argument. Empty by default: it renders and carries nothing. */
export function fakeTaskService(seed: readonly TaskView[] = []): TaskService {
  return new TaskService(fakeTaskRepository(seed));
}

/** A store that is on fire, for the tests that prove a task tool still cannot fail a turn. */
export function throwingTaskRepository(): TaskRepository {
  const fail = async (): Promise<never> => {
    throw new Error('database is locked');
  };
  return {
    listForThread: fail,
    append: fail,
    setStatus: fail,
  } as unknown as TaskRepository;
}
