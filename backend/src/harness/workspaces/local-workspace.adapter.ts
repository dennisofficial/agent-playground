import { Injectable } from '@nestjs/common';
import type { ProjectRecord } from '../projects/project.types';
import type {
  BaseRefreshResult,
  IntegrationResult,
  NewWorkspace,
  Workspace,
} from './workspace.types';
import type { WorkspaceGitPort } from './workspace-git.port';
import { WorkspaceService } from './workspace.service';

/**
 * The LOCAL `WorkspaceGitPort` — the ONLY path that runs until Phase 9 (`isContainerized` is hard-false).
 *
 * Every method delegates VERBATIM (same args, same return) to the host `WorkspaceService`. This is a
 * pure 1:1 pass-through ON PURPOSE: routing each consumer through `WorkspaceGitProvider.resolve(ctx)`
 * must be byte-identical to the pre-Phase-8 direct `this.workspaces.<method>(...)` call — runtime
 * behavior is UNCHANGED after this phase. No logic, no logging, no wrapping lives here; it is the
 * adapter shell that lets a single seam exist without altering today's behavior.
 */
@Injectable()
export class LocalWorkspaceAdapter implements WorkspaceGitPort {
  constructor(private readonly workspaces: WorkspaceService) {}

  create(
    input: NewWorkspace,
  ): Promise<{ workspace: Workspace; warning?: string }> {
    return this.workspaces.create(input);
  }

  remove(id: string): Promise<void> {
    return this.workspaces.remove(id);
  }

  refreshFromBase(id: string): Promise<BaseRefreshResult> {
    return this.workspaces.refreshFromBase(id);
  }

  mergeState(
    workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    return this.workspaces.mergeState(workspaceId);
  }

  ensureShared(
    id: string,
    name: string,
    startPoint?: string,
  ): Promise<string | undefined> {
    return this.workspaces.ensureShared(id, name, startPoint);
  }

  ensureSharedAtBase(
    id: string,
    name: string,
  ): Promise<
    { ok: true; sharedBranch: string } | { ok: false; reason: string }
  > {
    return this.workspaces.ensureSharedAtBase(id, name);
  }

  sharedRef(id: string): Promise<string | undefined> {
    return this.workspaces.sharedRef(id);
  }

  ownerDiff(
    id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    return this.workspaces.ownerDiff(id, sinceRef);
  }

  publish(id: string): Promise<IntegrationResult> {
    return this.workspaces.publish(id);
  }

  pull(id: string): Promise<IntegrationResult> {
    return this.workspaces.pull(id);
  }

  pushSharedToOrigin(
    id: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }> {
    return this.workspaces.pushSharedToOrigin(id);
  }

  projectRecordFor(workspaceId: string): Promise<ProjectRecord | undefined> {
    return this.workspaces.projectRecordFor(workspaceId);
  }

  sharedStatus(
    id: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined> {
    return this.workspaces.sharedStatus(id);
  }

  ensureReferenceClone(
    team: string,
    target: { projectId: string } | { gitUrl: string },
  ): Promise<{ path: string; projectId?: string; gitUrl: string }> {
    return this.workspaces.ensureReferenceClone(team, target);
  }

  referenceOrientation(path: string): Promise<string> {
    return this.workspaces.referenceOrientation(path);
  }
}
