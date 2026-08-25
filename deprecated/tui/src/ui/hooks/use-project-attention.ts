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
  const { attentionService, transitionReviewService } = useServices();
  const [facts, setFacts] = useState<Map<string, ThreadFacts[]>>(new Map());
  const [proposalThreadIds, setProposalThreadIds] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    void attentionService.threadFactsByProject().then((next) => {
      if (live) setFacts(next);
    });
    // Read HERE rather than passed in, so both pages that draw a project header get the signal
    // without threading it through either of them. A proposal is raised inside a turn, so the beat
    // this already runs on is the beat one appears on.
    void transitionReviewService.pendingProposals().then((pending) => {
      if (live) setProposalThreadIds(pending.map((row) => row.raisedByThreadId));
    });
    return () => {
      live = false;
    };
  }, [attentionService, transitionReviewService, running.length]);

  // `hasPullRequest` is deliberately NOT rolled up here, and this is a decision rather than an
  // omission: it is a fact about one JOB, and the union would let a single shipped job speak for a
  // whole project. `shipped` only draws where nothing is open, so a quiet project holding one merged
  // PR and nine idle jobs would read as out of your hands — which is false of the other nine. A
  // project header says nothing when it is quiet, and that stays the honest answer.
  return (projectId: string) =>
    jobAttention({
      threads: facts.get(projectId) ?? [],
      runningThreadIds: running,
      // Handed whole rather than filtered to this project: an id belonging to another project's
      // thread cannot match a fact in this one, so intersecting first would only cost a pass.
      proposalThreadIds,
    });
}
