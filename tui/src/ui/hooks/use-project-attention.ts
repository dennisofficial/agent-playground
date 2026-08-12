import { useEffect, useState } from "react";
import type { Attention } from "../../domain/attention.js";
import { jobAttention } from "../../domain/jobs-list.js";
import type { ThreadFacts } from "../../store/thread.repository.js";
import { useServices } from "../services.js";

/**
 * A project's condition: the union of every thread under it, run through the SAME function a job
 * and a thread run. One rule, three levels — the roll-up has no priority table at any of them.
 *
 * Re-read when the set of working threads changes, exactly like the lists below it: one query, and
 * only when something actually moved.
 */
export function useProjectAttention(
  running: readonly string[],
): (projectId: string) => Attention {
  const { attentionService } = useServices();
  const [facts, setFacts] = useState<Map<string, ThreadFacts[]>>(new Map());

  useEffect(() => {
    let live = true;
    void attentionService.threadFactsByProject().then((next) => {
      if (live) setFacts(next);
    });
    return () => {
      live = false;
    };
  }, [attentionService, running.length]);

  return (projectId: string) =>
    jobAttention({
      threads: facts.get(projectId) ?? [],
      runningThreadIds: running,
    });
}
