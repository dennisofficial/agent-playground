import {
  EServiceStatus,
  mayStillBeAlive,
  type ServiceEntry,
} from "../domain/services.js";
import { killGroup } from "./service-process.js";

/**
 * How long a group gets between SIGTERM and SIGKILL. Long enough for a node process to run its own
 * shutdown, short enough that nobody watches Atlas hang on the way out — and it is a ceiling, not a
 * wait: every escalation only signals what is still alive when it arrives.
 *
 * It lives here rather than in `service-reaper.ts` because both halves of the slice need it and the
 * reaper imports this file, not the other way round.
 */
export const REAP_GRACE_MS = 300;

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
 * Atlas. Asks, waits, then insists.
 *
 * **It is awaitable, and `deleteJob` must await it.** `purgeJobFiles` runs on the very next line
 * there and `rmSync`s the job directory — the logs and the `services.json` that is the only thing a
 * crash-orphan reconcile could ever match against. A fire-and-forget escalation destroyed that
 * evidence at t=0 while the group lived to t=300, which is the exact failure the ordering comment in
 * `workspace.service.ts` says the ordering exists to prevent.
 *
 * The escalation is about DEAFNESS, not slowness: a service that honours SIGTERM dies whether or not
 * anyone is watching, and the exit watcher records that within the grace, so the insistence below
 * skips it. What the wait buys is that a group which IGNORES the ask is dead before this resolves.
 *
 * Entries sit in `orphans` for the duration rather than vanishing, so a quit that lands mid-grace
 * still sweeps them — see `SweepDeps.orphans`.
 */
export async function reapJobEntries(
  deps: SweepDeps,
  args: { jobId: string },
): Promise<string[]> {
  const entries = deps.byJob.get(args.jobId);
  if (!entries) return [];
  const killed: string[] = [];
  for (const entry of entries) {
    if (!mayStillBeAlive(entry)) continue;
    try {
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
  if (pending.length === 0) return killed;

  deps.orphans.push(...pending);
  try {
    await Bun.sleep(REAP_GRACE_MS);
    // Re-asked per entry: anything the exit watcher saw die politely in the meantime is left alone,
    // because signalling a pgid the kernel has already reclaimed is signalling a stranger.
    for (const entry of pending) {
      if (mayStillBeAlive(entry)) insist({ entry, warn: deps.warn });
    }
  } finally {
    // In a `finally` so a throw mid-grace cannot strand entries in `orphans` for the life of the
    // process — they would be swept forever by every quit after this one.
    for (const entry of pending) {
      const at = deps.orphans.indexOf(entry);
      if (at >= 0) deps.orphans.splice(at, 1);
    }
  }
  return killed;
}

/**
 * SIGKILL one group and believe whatever the kernel answers. The one spelling of that, shared by
 * `reapJob`'s escalation and `reapGracefully`'s.
 */
export function insist(args: {
  entry: ServiceEntry;
  warn: (message: string) => void;
}): void {
  try {
    if (!killGroup({ pgid: args.entry.pgid, signal: "SIGKILL" })) {
      recordDenied(args.entry);
      return;
    }
    args.entry.status = EServiceStatus.killed;
  } catch (error) {
    args.warn(`could not kill service ${args.entry.id}: ${String(error)}`);
  }
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

  const sweep = (entry: ServiceEntry): boolean => {
    if (!mayStillBeAlive(entry)) return false;
    try {
      if (!killGroup({ pgid: entry.pgid, signal: args.signal })) {
        recordDenied(entry);
        return true;
      }
      entry.status = EServiceStatus.killed;
      signalled.push(entry);
      return true;
    } catch (error) {
      // Best-effort, and for a harder reason than `reapJob`'s: this runs on the way out of the
      // process, where one unsignallable group aborting the loop leaks every service after it.
      deps.warn(`could not reap service ${entry.id}: ${String(error)}`);
      return false;
    }
  };

  for (const [jobId, entries] of deps.byJob) {
    let touched = false;
    for (const entry of entries) touched = sweep(entry) || touched;
    if (touched) deps.persist(jobId);
  }
  // The orphans, and this is the whole point of their existing: a job deleted moments before a quit
  // is already out of `byJob`, so without this pass the group it is still waiting on is invisible to
  // BOTH quit paths — which is what `reapGracefully` and `onModuleDestroy` actually run. There is no
  // persist here: their job's mirror has been written and, on the deletion path, already deleted.
  for (const entry of deps.orphans) sweep(entry);
  return signalled;
}
