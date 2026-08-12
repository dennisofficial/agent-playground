import { useEffect, useState } from "react";
import type { TaskView } from "../../domain/tasks.js";
import { useServices } from "../services.js";

/**
 * The thread's task list, re-read whenever the transcript grows.
 *
 * A tool call and its result are messages, so the message count moving IS the signal that the agent
 * may have touched its list — no store to subscribe to, no polling clock, and no write path from the
 * turn runner into React. That is affordable only because the table is render-only: a read that is
 * one message late shows a checklist that is briefly stale, which is the failure this whole design
 * chose to accept.
 */
export function useTasks(args: {
  threadId: string;
  /** Anything that moves when the agent might have written — the message count, in practice. */
  revision: number;
}): TaskView[] {
  const { taskService } = useServices();
  const [tasks, setTasks] = useState<TaskView[]>([]);

  useEffect(() => {
    // Guarded because switching threads mid-read would otherwise land the old thread's list in the
    // new thread's panel — the same bug a shared conversation store once shipped.
    let live = true;
    void taskService.rows(args.threadId).then((rows) => {
      if (live) setTasks(rows);
    });
    return () => {
      live = false;
    };
  }, [taskService, args.threadId, args.revision]);

  return tasks;
}
