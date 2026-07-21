import { join } from 'node:path';

/** The repo worktree — the user's project, `/workspace` inside the pod. */
export function workspaceDir(atlasData: string, jobId: string): string {
  return join(atlasData, 'workspaces', jobId);
}

/** Atlas-owned per-job scratch, OUTSIDE the worktree — holds provisioning sentinels, never repo files. */
export function stateDir(atlasData: string, jobId: string): string {
  return join(atlasData, 'state', jobId);
}

/** Marks a completed clone+secrets materialization so a warm resume is a no-op. */
export function clonedSentinel(atlasData: string, jobId: string): string {
  return join(stateDir(atlasData, jobId), 'cloned');
}
