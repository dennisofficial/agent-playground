import { useEffect, useState } from "react";
import { proposalsByJob } from "../../domain/jobs-list.js";
import { useServices } from "../services.js";

/**
 * Which jobs are waiting on a keypress, keyed by job and carrying the threads that are waiting.
 *
 * One unscoped query for the whole screen: the list spans projects, and a pending row exists only
 * between an agent asking and Dennis answering, so there are never many. Re-read when the set of
 * working threads moves — a proposal is raised by a tool call inside a turn, so the turn ending is
 * the beat one appears on, and it is the beat every other list on this page already rides.
 */
export function usePendingProposals(
  running: readonly string[],
): Map<string, string[]> {
  const { transitionReviewService } = useServices();
  const [proposals, setProposals] = useState<Map<string, string[]>>(new Map());

  useEffect(() => {
    let live = true;
    void transitionReviewService.pendingProposals().then((pending) => {
      if (live) setProposals(proposalsByJob(pending));
    });
    return () => {
      live = false;
    };
  }, [transitionReviewService, running.length]);

  return proposals;
}
