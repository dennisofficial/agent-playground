import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { jobDir } from "../../domain/paths.js";
import type { ServiceEntry } from "../../domain/services.js";
import type { ServiceRegistryService } from "../service-registry.service.js";

/**
 * Helpers for the suites that drive REAL process groups.
 *
 * Every claim those suites make is an operating-system fact — a group dies with its leader, a
 * SIGTERM-deaf shell does not, ESRCH means gone — and a mocked `process.kill` would assert only that
 * a mock was called. So they spawn real shells, which makes cleanup a correctness concern rather
 * than tidiness: an assertion that throws before its kill leaves a SIGTERM-immune busy loop running
 * after the runner exits, and this suite has done exactly that to a developer's machine.
 *
 * `jobDir` resolves `~/.atlas` at module load and has NO test override, so these tests write into
 * the user's real Atlas home. That is why every job id is namespaced and tracked for removal.
 */

/** A shell that ignores SIGTERM outright, and keeps a live child so the group is never empty. */
export const DEAF = 'trap "" TERM; while true; do sleep 0.2; done';

/**
 * Job ids created by one spec file, so its `afterEach` can remove their directories.
 *
 * Each file makes its own tracker: `afterEach` is per-file in `bun:test`, and a shared mutable list
 * would have one file's cleanup racing another's still-running test.
 */
export function jobTracker(prefix: string): {
  newJob: () => string;
  cleanup: () => void;
} {
  const created: string[] = [];
  return {
    newJob: () => {
      const jobId = `${prefix}-${randomUUID()}`;
      created.push(jobId);
      return jobId;
    },
    cleanup: () => {
      for (const jobId of created.splice(0)) {
        rmSync(jobDir(jobId), { recursive: true, force: true });
      }
    },
  };
}

/**
 * `EPERM` counts as alive: the process exists, we merely may not signal it. Treating it as dead is
 * how a leak test comes back green over a process that is still running.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Poll rather than sleep a fixed span. A signal's effect lands whenever the kernel gets to it, and a
 * bare `await Bun.sleep(n)` either flakes or wastes the difference on every run.
 */
export async function waitFor(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Start a service and hand back the entry the registry recorded for it. */
export async function startService(args: {
  registry: ServiceRegistryService;
  jobId: string;
  command: string;
}): Promise<ServiceEntry> {
  await args.registry.start({
    jobId: args.jobId,
    command: args.command,
    description: "a service",
    cwd: tmpdir(),
  });
  const entries = args.registry.listFor(args.jobId);
  const entry = entries[entries.length - 1];
  if (!entry) throw new Error("no entry recorded");
  return entry;
}
