import { useEffect } from "react";
import { ClaimService } from "../../app/claim.service.js";
import { EClaimState } from "../../domain/claim.js";

/**
 * One instance for the process, constructed here rather than injected.
 *
 * `ClaimService` has no constructor dependencies — it is a pid, a tty and a filesystem — so routing
 * it through the container would add a provider, a resolve and a prop for nothing. This is not
 * "reaching into the container"; there is nothing in the container to reach for.
 */
const claimService = new ClaimService();

export { claimService };

/**
 * Holds the claim on whichever job this tile has open, and reacts when another one takes it.
 *
 * The grain is the JOB, not the thread or the session. Swapping threads inside a job must not
 * disturb it, and neither must `←` back to the job's own page — you are still in the job, managing
 * it. Only leaving the job entirely lets go, which falls out of this being keyed on `jobId`.
 *
 * There is deliberately no release on exit. Liveness is a pid probe, so a tile that dies without
 * cleaning up leaves a claim that reads as free the instant the process is gone. A crash cannot
 * lock you out of your own work, and the file it leaves behind is overwritten by the next holder.
 */
export function useClaim(args: {
  /** The job this tile is in, or null while it is browsing. */
  jobId: string | null;
  /** Another terminal took it: stop everything and get out. */
  onTakenOver: () => void;
}): void {
  const { jobId, onTakenOver } = args;

  /**
   * Holds and lets go. It does NOT acquire.
   *
   * Taking a job from another terminal is a decision, and decisions do not belong in a mount
   * effect — a hook that acquired on render would take the job from whoever had it merely because
   * a route appeared, with no prompt and nobody having pressed anything. Acquisition lives at the
   * two places that mean it: opening a job, and creating one.
   */
  useEffect(() => {
    if (!jobId) return;
    return () => claimService.release(jobId);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    // Watching, not polling. A poll interval is exactly the window in which two tiles both believe
    // they are driving, and that window is where the double-writer lives.
    return claimService.watch(jobId, () => {
      // ONLY a live other holder is a takeover. A claim that reads free is not: that is what we see
      // if the file is removed by hand, or if our own release races this callback — and demoting on
      // it would eject you from your own job for no reason.
      if (claimService.stateOf(jobId) !== EClaimState.held) return;
      onTakenOver();
    });
  }, [jobId, onTakenOver]);
}
