import { useEffect, useState } from "react";
import { useServices } from "../services.js";
import { useRunningThreads } from "./use-conversation.js";

/**
 * How many OTHER threads of this job have a turn in flight.
 *
 * A job runs several threads at once, and the conversation shows one of them. Without this, a
 * builder finishing in the background while you read the planner is invisible — you find out the
 * next time you happen to open the thread list.
 *
 * Deliberately scoped to this job. Other tiles are other tickets, and reporting their state here
 * would be the cross-tile noise that was rejected: six unrelated jobs, five of them irrelevant.
 */
export function useJobSiblings(args: {
  jobId: string;
  currentThreadId: string;
}): number {
  const { workspaceService } = useServices();
  const running = useRunningThreads();
  const [threadIds, setThreadIds] = useState<string[]>([]);

  // Re-read when the working set moves, the same signal the lists use: one SQLite read, and only
  // when a turn actually started or finished.
  useEffect(() => {
    let live = true;
    void workspaceService.listThreads(args.jobId).then((rows) => {
      if (live) setThreadIds(rows.map((row) => row.id));
    });
    return () => {
      live = false;
    };
  }, [workspaceService, args.jobId, running.length]);

  return running.filter(
    (id) => id !== args.currentThreadId && threadIds.includes(id),
  ).length;
}
