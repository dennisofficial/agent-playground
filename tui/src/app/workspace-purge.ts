import { rmSync } from "node:fs";
import { jobDir, sessionTapeDir } from "../domain/paths.js";
import type { ThreadRepository } from "../store/thread.repository.js";

/**
 * The two mechanics deleting a job or a project needs: which threads have to be evicted from memory
 * first, and which files on disk go with the rows.
 *
 * Plain functions rather than methods, for the same reason `turn-completion.ts` is one: they hold no
 * state, and `WorkspaceService` is at its size limit with the decisions — what deletion REFUSES, what
 * it leaves alone — which is the part worth reading there.
 */

/** Every thread of these jobs, so the conversation stores holding them can be dropped. */
export async function threadIdsFor(args: {
  threadRepository: ThreadRepository;
  jobIds: readonly string[];
}): Promise<string[]> {
  const ids: string[] = [];
  for (const jobId of args.jobIds) {
    const threads = await args.threadRepository.listForJob(jobId);
    ids.push(...threads.map((thread) => thread.id));
  }
  return ids;
}

/**
 * The job's own tree and the raw tape of every session it ran. Both are Atlas-owned and outside the
 * database, so the cascade cannot reach them — and the tape keys must be read BEFORE the rows go.
 */
export function purgeJobFiles(args: {
  jobId: string;
  engineSessionIds: readonly string[];
}): void {
  rmSync(jobDir(args.jobId), { recursive: true, force: true });
  for (const id of args.engineSessionIds) {
    rmSync(sessionTapeDir(id), { recursive: true, force: true });
  }
}
