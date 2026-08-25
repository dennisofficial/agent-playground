import { Injectable } from '@nestjs/common';
import { join } from 'node:path';

/** Resolves the on-disk paths of a job's workspace worktree and Atlas-owned scratch/sentinels. */
@Injectable()
export class WorkspacePathsService {
  /** The repo worktree — the user's project, `/workspace` inside the pod. */
  workspaceDir(atlasData: string, jobId: string): string {
    return join(atlasData, 'workspaces', jobId);
  }

  /** Atlas-owned per-job scratch, OUTSIDE the worktree — holds provisioning sentinels, never repo files. */
  stateDir(atlasData: string, jobId: string): string {
    return join(atlasData, 'state', jobId);
  }

  /** Marks a completed clone+secrets materialization so a warm resume is a no-op. */
  clonedSentinel(atlasData: string, jobId: string): string {
    return join(this.stateDir(atlasData, jobId), 'cloned');
  }
}
