import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { jobDir, jobServicesFile } from '../../domain/paths.js';
import type { AccountRepository } from '../../store/account.repository.js';
import type { JobRepository } from '../../store/job.repository.js';
import type { ProjectRepository } from '../../store/project.repository.js';
import type { ThreadRepository } from '../../store/thread.repository.js';
import type { ContextFolderService } from '../context-folder.service.js';
import type { ConversationService } from '../conversation.service.js';
import type { GitService } from '../git.service.js';
import type { ServiceRegistryService } from '../service-registry.service.js';
import type { SessionManagerService } from '../session-manager.service.js';
import { WorkspaceService } from '../workspace.service.js';
import type { WorktreeService } from '../worktree.service.js';

/**
 * Deleting a job reaps its services, and reaps them BEFORE the tree goes.
 *
 * The order is the whole assertion. `jobDir` holds both the logs and `services.json`, so a purge
 * that ran first would orphan a live process group AND destroy the only record naming its pgid —
 * a leak with nothing left to reconcile against, which is exactly what this job rejected in
 * charting. A test that only checked "reapJob was called" would pass with the two lines swapped.
 */

const jobs: string[] = [];

afterEach(() => {
  for (const jobId of jobs.splice(0)) {
    rmSync(jobDir(jobId), { recursive: true, force: true });
  }
});

function build() {
  const jobId = `spec-delete-${randomUUID()}`;
  jobs.push(jobId);
  // The tree a real job would have on disk, so "was it still there when reap ran" is answerable.
  mkdirSync(jobDir(jobId), { recursive: true });
  writeFileSync(jobServicesFile(jobId), '[]', 'utf8');

  /** What the registry SAW at the moment it was called, not merely that it was called. */
  const sawTree: boolean[] = [];
  const serviceRegistryService = {
    async reapJob(reaped: string): Promise<string[]> {
      expect(reaped).toBe(jobId);
      sawTree.push(existsSync(jobServicesFile(reaped)));
      return [];
    },
  } as unknown as ServiceRegistryService;

  const jobRepository = {
    async findWithProject(): Promise<null> {
      return null;
    },
    async engineSessionIdsFor(): Promise<string[]> {
      return [];
    },
    async remove(): Promise<void> {},
    async idsForProject(): Promise<string[]> {
      return [jobId];
    },
  } as unknown as JobRepository;

  const workspaceService = new WorkspaceService(
    { async remove(): Promise<void> {} } as unknown as ProjectRepository,
    jobRepository,
    { async listForJob(): Promise<[]> {
        return [];
      } } as unknown as ThreadRepository,
    {} as unknown as AccountRepository,
    {} as unknown as SessionManagerService,
    {} as unknown as ContextFolderService,
    { async evict(): Promise<void> {} } as unknown as ConversationService,
    {} as unknown as WorktreeService,
    {} as unknown as GitService,
    serviceRegistryService,
  );

  return { workspaceService, jobId, sawTree };
}

describe('deleting a job', () => {
  it('reaps the services while their record still exists, then removes the tree', async () => {
    const { workspaceService, jobId, sawTree } = build();

    await workspaceService.deleteJob(jobId);

    expect(sawTree).toEqual([true]);
    expect(existsSync(jobDir(jobId))).toBe(false);
  });
});

describe('deleting a project', () => {
  // Same hazard, second door: forgetting a project deletes every job under it, and each of those
  // jobs may be holding a process group.
  it('reaps each of its jobs before purging that job\'s files', async () => {
    const { workspaceService, sawTree } = build();

    await workspaceService.deleteProject('project-1');

    expect(sawTree).toEqual([true]);
  });
});

/** A job that never started one must delete exactly as it always did. */
describe('deleting a job with no services', () => {
  it('does not fail when the registry has nothing for it', async () => {
    const { workspaceService, jobId } = build();
    await workspaceService.deleteJob(jobId);
    expect(existsSync(jobDir(jobId))).toBe(false);
  });
});
