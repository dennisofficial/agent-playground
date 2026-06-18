import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Logger } from '@nestjs/common';

/**
 * Process-group spawn + reaping for in-sandbox engine turns (Phase 10, best-effort hardening).
 *
 * THE PROBLEM. An EXECUTE turn inside a sandbox routinely backgrounds long-running children — `pnpm
 * dev &`, `next dev`, a Nest server, `docker compose up` — as descendants of the engine's CLI
 * subprocess. When the turn aborts or the daemon shuts down, killing only the CLI subprocess leaves
 * those grandchildren orphaned (re-parented to init, still holding the port). They'd pile up across
 * turns. The sandbox is disposable, so this is hardening rather than correctness — but it's cheap to
 * do cleanly: spawn the CLI as a PROCESS-GROUP LEADER (`detached: true` → `setsid`), then a single
 * `process.kill(-pgid, signal)` reaps the leader AND every descendant it spawned in that group.
 *
 * WHY A CUSTOM SPAWN. The Claude Agent SDK exposes a `spawnClaudeCodeProcess` hook (documented "Use
 * this to run Claude Code in VMs, containers, or remote environments") that lets us own the spawn and
 * thus the process group, while returning the `SpawnedProcess` shape the SDK drives. We use it ONLY in
 * the relaxed-sandbox (daemon) posture — on the host the hook is never passed, so the SDK's own spawn
 * runs unchanged and host behavior is byte-identical.
 *
 * SCOPE / LIMITS (called out so the gaps are explicit, not silent):
 *  - POSIX only. `detached`+negative-pid group kill is a Unix construct; the sandbox image is Linux, so
 *    this is exactly its target. On a non-POSIX host the hook is never wired (relaxed mode is off).
 *  - Claude engine only. The Codex SDK spawns its CLI itself with no spawn hook, so we can't group it
 *    the same way; its descendants rely on the sandbox being torn down (documented in codex.engine.ts).
 *  - Best-effort. A child that re-parents into its OWN new session (double-fork daemonization) escapes
 *    the group — uncommon for dev servers, and the disposable sandbox is the real backstop.
 */

const logger = new Logger('EngineProcessGroup');

/** Minimal shape the Claude SDK's `spawnClaudeCodeProcess` is given / must return. Re-declared locally
 * (not imported) so this helper carries no SDK type dependency — it's a structural match. */
export interface GroupSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: { [k: string]: string | undefined };
  signal: AbortSignal;
}

/**
 * Live process-group leaders for the CURRENT daemon, by pgid (== the leader's pid for a `detached`
 * spawn). A turn's leader registers on spawn and de-registers on exit; daemon shutdown reaps whatever
 * remains. Module-scoped on purpose: there's one daemon process, and the set must outlive any single
 * engine instance so `OnApplicationShutdown` can sweep it.
 */
const liveGroups = new Set<number>();

/** Send `signal` to a whole process group (negative pid). Swallows ESRCH (already gone). */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    // ESRCH = the group is already gone (the common, benign case). Anything else is logged but never
    // thrown — reaping is best-effort and must not break abort/shutdown.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ESRCH') {
      logger.warn(`killGroup(${pgid}, ${signal}) failed: ${String(err)}`);
    }
  }
}

/**
 * Spawn the engine CLI as its own process-group leader and adapt it to the SDK's `SpawnedProcess`
 * interface. The SDK's forwarded `signal` (which fires only AFTER its stdin-EOF + grace window) is
 * wired to a GROUP kill so the whole subtree dies, not just the leader.
 */
export function spawnInOwnGroup(
  opts: GroupSpawnOptions,
): ChildProcessWithoutNullStreams {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    // The leader of a NEW process group (POSIX setsid). Its backgrounded descendants inherit the
    // group, so a single negative-pid kill reaps them all.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pgid = child.pid;
  if (pgid !== undefined) {
    liveGroups.add(pgid);
    const drop = (): void => {
      liveGroups.delete(pgid);
    };
    child.once('exit', drop);
    child.once('error', drop);

    // The SDK's graceful signal → reap the whole group (SIGTERM first; the SDK already gave the leader
    // its stdin-EOF grace before this fires). De-register either way.
    if (opts.signal.aborted) killGroup(pgid, 'SIGTERM');
    else
      opts.signal.addEventListener(
        'abort',
        () => killGroup(pgid, 'SIGTERM'),
        { once: true },
      );
  }

  return child;
}

/**
 * Daemon-shutdown sweep: signal every still-live engine process group. Called from the daemon's
 * `OnApplicationShutdown`. SIGTERM gives dev servers a chance to exit cleanly; the disposable sandbox
 * (and its inner Docker teardown) handles anything that ignores it.
 */
export function reapLiveProcessGroups(signal: NodeJS.Signals = 'SIGTERM'): number {
  const groups = [...liveGroups];
  for (const pgid of groups) killGroup(pgid, signal);
  if (groups.length) {
    logger.log(`reaped ${groups.length} lingering engine process group(s) on shutdown`);
  }
  return groups.length;
}

/** TEST-ONLY: the current live-group count (so specs can assert register/de-register without spawning
 * real processes is hard — kept minimal; the integration behavior is validated under a real sandbox). */
export function liveProcessGroupCount(): number {
  return liveGroups.size;
}
