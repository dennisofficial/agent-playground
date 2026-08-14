/**
 * A process the JOB owns rather than a turn.
 *
 * The whole of the distinction is LIFETIME. Finite work — a build, a CI poll, a backgrounded subagent
 * — stays on the native `Bash`/`Agent`/`Monitor` tools and reports back inside the turn that started
 * it, which is what holding the turn past `result` bought. A service is the other case: a dev server,
 * a watcher, anything whose whole point is that it is still there after the turn ends. It is a child
 * of the ATLAS process, not of the per-turn CLI, which is why it survives turns, sessions and seams
 * for free rather than by any machinery.
 *
 * Start, log path, stop, list — and deliberately nothing else. There is no completion signal and no
 * report channel: a service that finished would be finite work, and finite work belongs to the hold.
 */

export enum EServiceStatus {
  running = "running",
  /** The process ended on its own. `exitCode` says how. */
  exited = "exited",
  /** Atlas killed the group — `service_stop`, a claim release, a job deletion, or quitting. */
  killed = "killed",
}

export type ServiceEntry = {
  id: string;
  jobId: string;
  command: string;
  description: string;
  cwd: string;
  pid: number;
  /**
   * The process GROUP, which is what a kill has to name. A real service is a tree — `pnpm dev` spawns
   * node spawns more — so killing the pid alone leaves the grandchildren. Recorded separately from
   * `pid` even though a detached child is its own group leader today: the pair is what the deferred
   * crash-orphan reconcile has to match against, and a field derived at read time is a field that is
   * wrong the first time the spawn strategy changes.
   */
  pgid: number;
  logPath: string;
  startedAt: number;
  status: EServiceStatus;
  exitCode?: number;
};

/** What a human is shown as live, and what a graceful reap signals. */
export function isRunning(entry: ServiceEntry): boolean {
  return entry.status === EServiceStatus.running;
}

/**
 * Whether Atlas has ever WATCHED this process end — which is a different question from whether it
 * calls it running, and the one the exit backstop has to ask.
 *
 * A group that has been signalled is `killed` in memory from the moment the signal is sent, while it
 * may still be dying or ignoring SIGTERM outright. Sweeping only `running` on the way out would drop
 * precisely the services a graceful reap had already started on — which is every service, on every
 * ordinary quit. `exitCode` is written by the exit watcher and nowhere else, so its absence is the
 * one honest record of "we never saw this die".
 */
export function mayStillBeAlive(entry: ServiceEntry): boolean {
  return entry.exitCode === undefined;
}

/** `4s`, `12m`, `3h 07m`. Coarse on purpose: nobody reads a dev server's uptime to the second. */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function describeStatus(entry: ServiceEntry): string {
  if (entry.status !== EServiceStatus.exited) return entry.status;
  return entry.exitCode === undefined
    ? "exited"
    : `exited (${entry.exitCode})`;
}

/**
 * One service, as one line the agent reads back.
 *
 * The id leads because it is the only thing `service_stop` takes, and a thread opened after a seam
 * inherits the job's services with no other way to learn one.
 */
export function describeService(args: {
  entry: ServiceEntry;
  now: number;
}): string {
  const { entry } = args;
  const age = formatUptime(args.now - entry.startedAt);
  // Nothing records when a dead service died, so its age is time since it STARTED — which reads as
  // "it ran for three hours" if left unlabelled, when it may have fallen over in the first second.
  const since =
    entry.status === EServiceStatus.running ? `up ${age}` : `started ${age} ago`;
  return `${entry.id}  ${describeStatus(entry)}  ${since}  ${entry.description}\n    ${entry.command}\n    log: ${entry.logPath}`;
}

/**
 * The job's services, rendered. Prose when there are none rather than an empty list — an agent that
 * reads `[]` learns nothing, and the empty case is exactly when it should be told where services
 * come from.
 */
export function renderServiceList(args: {
  entries: readonly ServiceEntry[];
  now: number;
}): string {
  if (args.entries.length === 0) {
    return "No services in this job. `service_start` is what puts one here — a dev server, a watcher, anything that should still be running after this turn ends.";
  }
  const lines = args.entries.map((entry) =>
    describeService({ entry, now: args.now }),
  );
  return `${args.entries.length} service${args.entries.length === 1 ? "" : "s"} in this job:\n\n${lines.join("\n\n")}`;
}
