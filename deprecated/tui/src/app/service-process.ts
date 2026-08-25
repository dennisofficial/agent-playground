import { closeSync, openSync, readFileSync, rmSync } from "node:fs";

/**
 * The two OS-level mechanics a job-owned service needs: putting one in its own process group, and
 * killing that group.
 *
 * Plain functions rather than methods for the same reason `workspace-purge.ts` is one — they hold no
 * state, and the decisions worth reading (what a stop MEANS, when a job is reaped) live in the
 * service beside them.
 *
 * Deliberately NOT a reimplementation of the native `Bash` tool. There is no shell-profile snapshot,
 * no glob or alias normalisation, no cwd persistence between calls and no sandbox decision: a service
 * is started once, with an explicit command and an explicit cwd, and rebuilding all of that to fix a
 * background path while degrading a working foreground one is the trade this job already rejected.
 */

export type SpawnedService = {
  pid: number;
  /** Equal to `pid` while the child is a group leader — see `detached` below. Recorded, not derived. */
  pgid: number;
  /** Resolves with the exit code when the child ends on its own or is killed. */
  exited: Promise<number>;
};

/**
 * Start a detached child with both its streams pointed at one log file.
 *
 * **`detached: true` is the load-bearing flag.** A real service is a tree — `pnpm dev` spawns node
 * spawns more — and killing the shell alone leaves the grandchildren behind. Its own process group
 * makes `process.kill(-pgid, …)` reap the whole tree, which is the CLI's own pattern.
 *
 * The accepted cost, stated plainly: a **SIGKILL** of Atlas leaks the tree, because no handler runs.
 * Every other exit path is covered by the reaper; that one is the deferred crash-orphan job, and
 * `services.json` is what makes it fixable.
 *
 * `stdin` is ignored rather than inherited: a service that read the terminal would fight the renderer
 * for the same bytes, and nothing about a dev server wants a keyboard.
 */
export function spawnService(args: {
  command: string;
  cwd: string;
  logPath: string;
}): SpawnedService {
  // One fd for both streams, so interleaving in the log matches interleaving in time. Closed here
  // because the child holds its own dup — leaving it open would leak one descriptor per service.
  const fd = openSync(args.logPath, "a");
  try {
    const child = Bun.spawn(["/bin/sh", "-c", args.command], {
      cwd: args.cwd,
      detached: true,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    // Atlas must be able to quit while a service runs. Without this the child keeps the event loop
    // alive and the reaper never gets to run, which is the opposite of the promise.
    child.unref();
    return { pid: child.pid, pgid: child.pid, exited: child.exited };
  } catch (error) {
    // A spawn that never happened must not leave an empty log behind claiming it did. The throw
    // still propagates — `atlasToolServer` renders it as an `isError` the agent can retry against.
    rmSync(args.logPath, { force: true });
    throw error;
  } finally {
    closeSync(fd);
  }
}

/**
 * The last few lines of a service's log, for the one moment the model will not go and read it: a
 * command that died on the spot. `sh: pnpm: command not found` is the whole diagnosis, and it is
 * worth putting in front of the caller rather than behind a path.
 */
export function logTail(args: { logPath: string; lines: number }): string {
  try {
    return readFileSync(args.logPath, "utf8").trimEnd().split("\n").slice(-args.lines).join("\n");
  } catch {
    // No log is not a failure worth reporting over — the exit code is still the answer.
    return "";
  }
}

/**
 * Signal a service's whole group. `false` means it was already gone.
 *
 * By GROUP (`-pgid`), never by pid — that is the entire reason for spawning detached, and a pid kill
 * would leave exactly the grandchildren this facility exists to be able to reap.
 *
 * Only `ESRCH` is swallowed, and only because "already gone" is the answer rather than a failure.
 * `EPERM` is a real problem — a group we cannot signal is a leak we would otherwise report as a
 * successful stop — so it is left to throw.
 */
export function killGroup(args: {
  pgid: number;
  signal: NodeJS.Signals;
}): boolean {
  // The one call in this slice where a bad number is unrecoverable: POSIX reads `kill(0, sig)` as
  // "my OWN process group", so a `pgid` of 0 would have Atlas signal itself and everything sharing
  // its terminal. Unreachable from a live spawn, but `pgid` round-trips through `services.json` and
  // the deferred reconcile is specified to read it back.
  if (!Number.isInteger(args.pgid) || args.pgid <= 1) {
    throw new Error(`refusing to signal process group ${args.pgid}`);
  }
  try {
    process.kill(-args.pgid, args.signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
