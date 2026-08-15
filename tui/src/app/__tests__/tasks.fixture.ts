import { carriedTasks, type TaskView } from '../../domain/tasks.js';
import { ETaskStatus } from '../../generated/prisma/enums.js';
import type { TaskRepository } from '../../store/task.repository.js';
import { TaskService } from '../task.service.js';

/**
 * The task list, in memory, with the repository's exact semantics — including the one that matters:
 * **a miss is `null`, not a throw.** Shared because `ThreadSeamService` now takes a `TaskService`,
 * so every seam fixture needs one whether or not the test cares about tasks.
 *
 * Keyed by thread, which `carryForward` made load-bearing: the whole claim of a successor's list is
 * that it is a DIFFERENT list, and a fake with one array behind every id would have proved the
 * opposite while passing. The seed lands on `seedThreadId` so a single-thread test can ignore it.
 */
export function fakeTaskRepository(
  seed: readonly TaskView[] = [],
  seedThreadId = 'thread-1',
): TaskRepository {
  const byThread = new Map<string, TaskView[]>([
    [seedThreadId, seed.map((task) => ({ ...task }))],
  ]);
  const listOf = (threadId: string): TaskView[] => {
    const found = byThread.get(threadId);
    if (found) return found;
    const fresh: TaskView[] = [];
    byThread.set(threadId, fresh);
    return fresh;
  };
  const copyOf = (threadId: string): TaskView[] =>
    listOf(threadId).map((task) => ({ ...task }));

  return {
    listForThread: async (threadId: string) => copyOf(threadId),
    append: async (args: { threadId: string; texts: readonly string[] }) => {
      const tasks = listOf(args.threadId);
      // Off the highest ever used, never the count — a retired number is never reissued.
      let ordinal = tasks.reduce((high, task) => Math.max(high, task.ordinal), 0) + 1;
      for (const text of args.texts) {
        tasks.push({ ordinal: ordinal++, text, status: ETaskStatus.pending });
      }
      return copyOf(args.threadId);
    },
    setStatus: async (args: {
      threadId: string;
      ordinal: number;
      status: ETaskStatus;
      text?: string;
    }) => {
      const found = listOf(args.threadId).find((task) => task.ordinal === args.ordinal);
      if (!found) return null;
      found.status = args.status;
      if (args.text !== undefined) found.text = args.text;
      return copyOf(args.threadId);
    },
    carryForward: async (args: {
      fromThreadId: string;
      toThreadId: string;
      declared: readonly number[];
    }) => {
      const resolved = carriedTasks({
        tasks: listOf(args.fromThreadId),
        declared: args.declared,
      });
      listOf(args.toThreadId).push(...resolved.carried.map((task) => ({ ...task })));
      return resolved;
    },
  } as unknown as TaskRepository;
}

/** A seam fixture's eighth constructor argument. Empty by default: it renders and carries nothing. */
export function fakeTaskService(
  seed: readonly TaskView[] = [],
  seedThreadId?: string,
): TaskService {
  return new TaskService(fakeTaskRepository(seed, seedThreadId));
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
    carryForward: fail,
  } as unknown as TaskRepository;
}
