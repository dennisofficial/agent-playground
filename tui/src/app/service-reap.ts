import {
  EServiceStatus,
  mayStillBeAlive,
  type ServiceEntry,
} from "../domain/services.js";
import { killGroup } from "./service-process.js";
import { REAP_GRACE_MS } from "./service-reaper.js";

/**
 * The two sweeps, lifted out of the registry so the class stays under the line cap and so the rule
 * they share has one place to live.
 *
 * That rule is the whole of this file: **signal what may still be alive, and believe the kernel.**
 * Both sweeps ask `mayStillBeAlive` rather than `isRunning`, because a group is recorded `killed`
 * the moment a signal is SENT and a service that traps SIGTERM is `killed` while still holding its
 * port. And both write `exited` when `killGroup` comes back ESRCH — see `recordDenied` below.
 */

export type SweepDeps = {
  byJob: Map<string, ServiceEntry[]>;
  /**
   * Groups that have been signalled but are not yet confirmed dead, and no longer belong to any job.
   *
   * `allServices()` concatenates this, which is the whole reason it exists: `reapJob` forgets the
   * job immediately — the UI and the mirror should stop showing a deleted job at once — but a pgid
   * that is still alive must stay reachable to the exit backstop, or a quit inside the grace window
   * leaks it with nothing left that can see it.
   */
  orphans: ServiceEntry[];
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
 * Kill everything one job owns and forget it — a job deletion, or a claim taken over by another
 * Atlas.
 *
 * It ASKS, then insists, and it has to do both itself. `reapAll` can afford to hand its list to
 * `reapGracefully` and be awaited; this one cannot be, because it forgets the job on the way out —
 * after `byJob.delete` there is no job left for a later pass to sweep. So the escalation is armed
 * here, and the entries move to `orphans` rather than vanishing, which is what keeps them reachable
 * to the exit backstop for the 300 ms in between.
 *
 * The polite case needs no watcher: a service that honours SIGTERM dies whether or not anyone is
 * looking. The escalation exists for DEAFNESS, not for slowness, which is why the grace is a
 * timeout rather than something a caller has to await.
 *
 * Synchronous, and it stays that way for the callers' sake rather than for an exit path's: a job
 * deletion should not sit for 300 ms per job, and `use-claim`'s takeover callback is not async.
 */
export function reapJobEntries(
  deps: SweepDeps,
  args: { jobId: string; graceMs?: number },
): string[] {
  const entries = deps.byJob.get(args.jobId);
  if (!entries) return [];
  const killed: string[] = [];
  for (const entry of entries) {
    if (!mayStillBeAlive(entry)) continue;
    try {
      // SIGTERM first even here: this is the only chance the service gets to shut down cleanly, and
      // the insistence below is 300 ms away.
      if (!killGroup({ pgid: entry.pgid, signal: "SIGTERM" })) {
        recordDenied(entry);
        continue;
      }
      killed.push(entry.id);
      entry.status = EServiceStatus.killed;
    } catch (error) {
      // Best-effort, unlike `stop()` where a throw is the model's answer. This runs from a job
      // deletion that has already removed the row and from a claim-takeover callback, and one
      // unkillable group must not abort the loop, skip the persist, or leave the job in the map.
      deps.warn(`could not reap service ${entry.id}: ${String(error)}`);
    }
  }
  // Persist BEFORE forgetting, so a mirror left behind by a deletion that then fails says these were
  // stopped rather than claiming they are live.
  deps.persist(args.jobId);
  deps.byJob.delete(args.jobId);

  const pending = entries.filter(mayStillBeAlive);
  if (pending.length > 0) {
    deps.orphans.push(...pending);
    scheduleEscalation({ deps, pending, graceMs: args.graceMs ?? REAP_GRACE_MS });
  }
  return killed;
}

/**
 * The second half of `reapJob`, 300 ms later: SIGKILL whatever is still there, then stop tracking it
 * either way.
 *
 * `unref`'d, deliberately. If Atlas is on its way out it must not be held open waiting to be polite
 * to a process it is about to SIGKILL anyway — and it does not need to be, because the orphan is in
 * `allServices()` until this runs, so layer 3 will do exactly this job on the way past.
 */
function scheduleEscalation(args: {
  deps: SweepDeps;
  pending: readonly ServiceEntry[];
  graceMs: number;
}): void {
  const timer = setTimeout(() => {
    for (const entry of args.pending) {
      if (mayStillBeAlive(entry)) {
        try {
          if (!killGroup({ pgid: entry.pgid, signal: "SIGKILL" })) recordDenied(entry);
          else entry.status = EServiceStatus.killed;
        } catch (error) {
          args.deps.warn(`could not kill service ${entry.id}: ${String(error)}`);
        }
      }
      const at = args.deps.orphans.indexOf(entry);
      if (at >= 0) args.deps.orphans.splice(at, 1);
    }
  }, args.graceMs);
  timer.unref?.();
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
