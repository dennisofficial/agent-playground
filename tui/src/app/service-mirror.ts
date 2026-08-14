import { mkdirSync, writeFileSync } from "node:fs";
import { jobDir, jobServicesFile } from "../domain/paths.js";
import type { ServiceEntry } from "../domain/services.js";

/**
 * The on-disk mirror of a job's registry. Nothing in this job reads it back — it exists so the
 * deferred crash-orphan reconcile has a pid and a pgid to match against.
 *
 * A failure is reported to `warn` and swallowed on purpose: the process is already running, and
 * turning a successful start into a thrown tool result over a bookkeeping file would lose the id the
 * caller needs to stop it.
 */
export function writeServiceMirror(args: {
  jobId: string;
  entries: readonly ServiceEntry[];
  warn: (message: string) => void;
}): void {
  try {
    mkdirSync(jobDir(args.jobId), { recursive: true });
    writeFileSync(
      jobServicesFile(args.jobId),
      `${JSON.stringify(args.entries, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    args.warn(`could not write services.json for ${args.jobId}: ${String(error)}`);
  }
}
