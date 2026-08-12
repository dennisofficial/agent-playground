import { EToolTier } from '../../domain/tool-surface.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import type { JobRepository } from '../../store/job.repository.js';
import { atlasToolsFor } from './registry.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

/**
 * What a thread's tools are bound to, and the list that comes out of it.
 *
 * Outside the seam for the reason `phase-transition.ts` and `thread-delegation.ts` are: it is a
 * function of its collaborators, and the service is the DI holder rather than the place decisions
 * live. `actions` is passed in rather than injected — the only implementation is the seam itself,
 * which is what closes the tools-need-turns-need-tools loop without a port or a `forwardRef`.
 */
export async function toolsForThread(args: {
  jobRepository: JobRepository;
  actions: ToolActions;
  job: Job;
  thread: Thread;
  cwd: string;
}): Promise<readonly AtlasTool[]> {
  const ctx = await toolContextFor(args);
  return atlasToolsFor({ ctx, actions: args.actions });
}

export async function toolContextFor(args: {
  jobRepository: JobRepository;
  job: Job;
  thread: Thread;
  cwd: string;
}): Promise<ToolContext> {
  const phases = await args.jobRepository.listPhases(args.job.id);
  const phase = phases.find((row) => row.id === args.thread.phaseId);
  if (!phase) {
    throw new Error(`thread ${args.thread.id} has no phase on job ${args.job.id}`);
  }
  return {
    job: args.job,
    thread: args.thread,
    phase: phase.kind,
    cwd: args.cwd,
    // Teammates are ticket 14. Until then every turn Atlas fires is a thread's own.
    tier: EToolTier.thread,
  };
}
