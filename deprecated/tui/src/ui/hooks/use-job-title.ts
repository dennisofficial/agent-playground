import { useSyncExternalStore } from "react";
import { useServices } from "../services.js";

/**
 * What this job is called RIGHT NOW.
 *
 * A page holds a job row it read once, and two things rename a job after that read: the titler
 * landing on a job created seconds ago, and a rename typed on the job's own page. Both publish to
 * `JobTitleService`, so every header reading through this hook moves at the same moment — including
 * the one on a frame below the page the rename happened on.
 *
 * The row's own title is the fallback and the common case: a job nobody has renamed this session
 * never appears in the store at all.
 */
export function useJobTitle(job: { id: string; title: string }): string {
  const { jobTitleService } = useServices();
  return useSyncExternalStore(
    jobTitleService.subscribe,
    () => jobTitleService.titleOf(job.id) ?? job.title,
  );
}
