import type { ProjectRecord } from '../projects/project.types';
import type {
  BaseRefreshResult,
  IntegrationResult,
  NewWorkspace,
  Workspace,
} from './workspace.types';
import type { WorkspaceGitPort } from './workspace-git.port';
import type { DaemonClient } from './daemon-client';

/**
 * The REMOTE `WorkspaceGitPort` — forwards each git op to the in-sandbox daemon's `DaemonGitService`
 * over Redis (the Phase-5 typed git RPC: `DaemonClient.gitCall(workspaceId, method, args)`), returning
 * the daemon's result.
 *
 * DORMANT THIS PHASE. `isContainerized` is hard-false until Phase 9, so the provider never resolves to
 * this adapter at runtime; it is built and exercised ONLY by unit tests with a fake `DaemonClient`. The
 * daemon's `DaemonGitService` already implements the matching surface (Phase 4).
 *
 * Bound to a single `workspaceId` — the SANDBOX (one container = one repo) the RPCs dispatch to. The
 * provider constructs one per resolved sandbox.
 *
 * IDENTITY NOTE (Phase-9 seam): the host `WorkspaceService` keys ops by `ws-NNN`, whereas the daemon's
 * `DaemonGitService` keys per-worktree ops by the HARNESS SESSION ID (one container = one repo, a
 * worktree per session). This adapter forwards the host-side positional args verbatim to `gitCall`; the
 * arg-shape translation (host workspace id ⇒ daemon session id for the per-worktree methods) is wired
 * when Phase 9 flips routing on and supplies real session context. Until then nothing reaches here, so
 * the verbatim forward is correct for the unit-test contract (each method maps 1:1 to a typed RPC).
 */
export class DaemonGitAdapter implements WorkspaceGitPort {
  constructor(
    private readonly daemon: DaemonClient,
    /** The sandbox the git RPCs dispatch to (`DaemonClient.gitCall`'s first arg). */
    private readonly workspaceId: string,
  ) {}

  /** Dispatch one `DaemonGitService` method as a typed git RPC and return its (typed) result. */
  private call<T>(method: string, args: unknown[]): Promise<T> {
    return this.daemon.gitCall(this.workspaceId, method, args) as Promise<T>;
  }

  create(
    input: NewWorkspace,
  ): Promise<{ workspace: Workspace; warning?: string }> {
    return this.call('create', [input]);
  }

  remove(id: string): Promise<void> {
    return this.call('remove', [id]);
  }

  refreshFromBase(id: string): Promise<BaseRefreshResult> {
    return this.call('refreshFromBase', [id]);
  }

  mergeState(
    workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    return this.call('mergeState', [workspaceId]);
  }

  ensureShared(
    id: string,
    name: string,
    startPoint?: string,
  ): Promise<string | undefined> {
    return this.call('ensureShared', [id, name, startPoint]);
  }

  ensureSharedAtBase(
    id: string,
    name: string,
  ): Promise<
    { ok: true; sharedBranch: string } | { ok: false; reason: string }
  > {
    return this.call('ensureSharedAtBase', [id, name]);
  }

  sharedRef(id: string): Promise<string | undefined> {
    return this.call('sharedRef', [id]);
  }

  ownerDiff(
    id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    return this.call('ownerDiff', [id, sinceRef]);
  }

  publish(id: string): Promise<IntegrationResult> {
    return this.call('publish', [id]);
  }

  pull(id: string): Promise<IntegrationResult> {
    return this.call('pull', [id]);
  }

  pushSharedToOrigin(
    id: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }> {
    return this.call('pushSharedToOrigin', [id]);
  }

  projectRecordFor(workspaceId: string): Promise<ProjectRecord | undefined> {
    return this.call('projectRecordFor', [workspaceId]);
  }

  sharedStatus(
    id: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined> {
    return this.call('sharedStatus', [id]);
  }

  ensureReferenceClone(
    team: string,
    target: { projectId: string } | { gitUrl: string },
  ): Promise<{ path: string; projectId?: string; gitUrl: string }> {
    return this.call('ensureReferenceClone', [team, target]);
  }

  referenceOrientation(path: string): Promise<string> {
    return this.call('referenceOrientation', [path]);
  }
}
