import {
  EServiceStatus,
  EStopAction,
  mayStillBeAlive,
  stopAction,
  type ServiceEntry,
} from "../domain/services.js";
import { killGroup } from "./service-process.js";

/**
 * The two sweeps, lifted out of the registry so the class stays under the line cap and so the rule
 * they share has one place to live.
 *
 * That rule is the whole of this file: **signal what may still be alive, and believe the kernel.**
 * Both sweeps ask `mayStillBeAlive` rather than `isRunning`, because a group is recorded `killed`
 * the moment a signal is SENT and a service that traps SIGTERM is `killed` while still holding its
 * port. And both write `exited` when `killGroup` comes back ESRCH — see `recordDenied` below.
 */

type SweepDeps = {
  byJob: Map<string, ServiceEntry[]>;
  persist: (jobId: string) => void;
  warn: (message: string) => void;
};

/**
 * ESRCH is an answer, not a failure, and it is a FINAL one.
 *
 * The kernel has just said this group does not exist. Leaving the row `running` — which is what
 * both sweeps used to do — is a claim Atlas has this instant been told is false, and it costs twice:
 * the exit backstop signals the pgid again on the way out, and the deferred crash-orphan reconcile
 * reads a live-looking pgid off `services.json` that the kernel is free to have reissued to a
 * stranger. `exited` with NO `exitCode` is the honest record: gone, but not by a death Atlas
 * watched, which is exactly what `stop()` already writes on the same branch.
 */
function recordDenied(entry: ServiceEntry): void {
  entry.status = EServiceStatus.exited;
}

/**
 * Kill everything one job owns and forget it — a job deletion, or a claim released to another Atlas.
 *
 * It ESCALATES, and that is the difference from `reapAll`. This sweep deletes the job from the map
 * at the end, so it is the last layer that will ever hold these pgids: a group merely re-asked here
 * is orphaned and unrecorded at once, with no backstop left that can find it. `reapGracefully` can
 * afford to ask politely and come back in 300 ms because it comes back; this one does not, so a
 * service that has already ignored one SIGTERM is SIGKILLed now.
 *
 * Synchronous, deliberately: it is reachable from an exit path where nothing awaits.
 */
export function reapJobEntries(
  deps: SweepDeps,
  args: { jobId: string },
): string[] {
  const entries = deps.byJob.get(args.jobId);
  if (!entries) return [];
  const killed: string[] = [];
  for (const entry of entries) {
    const action = stopAction(entry);
    if (action === EStopAction.gone) continue;
    try {
      const signal =
        action === EStopAction.kill ? "SIGKILL" : ("SIGTERM" as const);
      if (!killGroup({ pgid: entry.pgid, signal })) {
        recordDenied(entry);
        continue;
      }
      // Only a group we actually signalled is credited as killed.
      killed.push(entry.id);
      entry.status = EServiceStatus.killed;
    } catch (error) {
      // Best-effort, unlike `stop()` where a throw is the model's answer. This runs from a job
      // deletion that has already removed the row and from a React effect cleanup, and one
      // unkillable group must not abort the loop, skip the persist, or leave the job in the map.
      deps.warn(`could not reap service ${entry.id}: ${String(error)}`);
    }
  }
  // Persist BEFORE forgetting, so a mirror left behind by a deletion that then fails says these were
  // stopped rather than claiming they are live.
  deps.persist(args.jobId);
  deps.byJob.delete(args.jobId);
  return killed;
}

/**
 * Signal every group in every job — what quitting Atlas does, as against `reapJob`'s one job.
 *
 * It does NOT escalate on its own: it returns the entries it actually signalled, and
 * `reapGracefully` takes that list, waits out the grace, and insists on whatever is still alive.
 * Splitting it that way is what gives a dev server its chance to shut down cleanly, which is the
 * entire reason the graceful path exists.
 *
 * The jobs stay in the map, unlike a deletion — Atlas is going away, not forgetting these jobs, and
 * the exit backstop still has to be able to see them.
 */
export function reapAllEntries(
  deps: SweepDeps,
  args: { signal: NodeJS.Signals },
): ServiceEntry[] {
  const signalled: ServiceEntry[] = [];
  for (const [jobId, entries] of deps.byJob) {
    let touched = false;
    for (const entry of entries) {
      if (!mayStillBeAlive(entry)) continue;
      try {
        if (!killGroup({ pgid: entry.pgid, signal: args.signal })) {
          recordDenied(entry);
          touched = true;
          continue;
        }
        entry.status = EServiceStatus.killed;
        signalled.push(entry);
        touched = true;
      } catch (error) {
        // Best-effort, and for a harder reason than `reapJob`'s: this runs on the way out of the
        // process, where one unsignallable group aborting the loop leaks every service after it.
        deps.warn(`could not reap service ${entry.id}: ${String(error)}`);
      }
    }
    if (touched) deps.persist(jobId);
  }
  return signalled;
}
