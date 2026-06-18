import type { PullRequestResult } from '../projects/github-api.service';
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
 * over Redis (the typed git RPC: `DaemonClient.gitCall(sandboxId, method, args)`), returning the daemon's
 * result.
 *
 * THE HOST↔DAEMON IDENTITY MAPPING (the three-tier model):
 *   - The RPC dispatch target is the SANDBOX uuid (`sandboxId`) — the container's command stream.
 *   - The daemon keys per-WORKTREE ops by the WORK AREA id (`workAreaId`) — one sandbox (one repo) hosts
 *     MANY work-area worktrees (`.workspaces/<workAreaId>`); the SESSIONS in a work area share its tree.
 *   So for every per-worktree method we DROP the host workspace-id arg and SUBSTITUTE `workAreaId` as the
 *   daemon method's leading arg. `RemoteTurnDispatcher` keys the engine cwd off the SAME `workAreaId`
 *   (its `RunCommandPayload.workAreaId`), so a turn's cwd and its git ops always address the SAME tree.
 *   No session is needed — so workspace-id-only ops (publish/pull/refresh/remove) route cleanly too.
 *
 * Constructed PER-RESOLVE by `WorkspaceGitProvider.resolve(ctx)`, bound to the `(sandboxId, workAreaId)`
 * the provider resolved via `WorkspaceRegistry`. Exercised by unit tests with a fake `DaemonClient`.
 *
 * `sharedStatus` + `referenceOrientation` route to real daemon RPCs. ONE host port method has NO daemon
 * counterpart by design: `projectRecordFor` — a HOST-REGISTRY / multi-project read the single-repo daemon
 * doesn't model (its clone IS the project). It stays a loud `unavailable()` rejection; containerized
 * callers that used to need it (review/ship, open_pr) FORK on `WorkspaceGitProvider.isContainerized` and
 * use the off-port daemon ops below instead.
 *
 * OFF-PORT DAEMON OPS (`reviewRange`/`attachDesign`/`openPr`/`markReady`/`commentPr`): NOT on
 * `WorkspaceGitPort`. They're daemon-only — reached via `WorkspaceGitProvider.daemonFor(ctx)`. The daemon
 * is self-sufficient for them (it owns its repo + base + the GitHub credential).
 */
export class DaemonGitAdapter implements WorkspaceGitPort {
  constructor(
    private readonly daemon: DaemonClient,
    /** The sandbox the git RPCs dispatch to (`DaemonClient.gitCall`'s first arg = the container id). */
    private readonly sandboxId: string,
    /** The work area whose worktree the per-worktree ops address (the daemon's worktree key). */
    private readonly workAreaId: string,
  ) {}

  /** Dispatch one `DaemonGitService` method as a typed git RPC and return its (typed) result. */
  private call<T>(method: string, args: unknown[]): Promise<T> {
    return this.daemon.gitCall(this.sandboxId, method, args) as Promise<T>;
  }

  /** Dispatch a per-worktree method: substitute the host workspace-id arg with the daemon's worktree key
   * (`workAreaId`) and prepend it to `rest`. No session needed — the work area IS the worktree. */
  private worktreeCall<T>(method: string, rest: unknown[] = []): Promise<T> {
    return this.call<T>(method, [this.workAreaId, ...rest]);
  }

  /** A rejected promise for a host-only method the single-repo daemon doesn't model (loud, not
   * silent-wrong; rejected so the async contract holds for `.catch()` callers). */
  private unavailable<T>(method: string): Promise<T> {
    return Promise.reject(
      new Error(
        `DaemonGitAdapter: '${method}' has no in-sandbox counterpart (host-registry/multi-project op) — known containerized gap.`,
      ),
    );
  }

  // ── per-worktree methods: host workspace-id arg → daemon session-id key ──────────────────────────

  /** Work-area creation does NOT go through the port in a sandbox: `create_workspace` ensures the sandbox
   * (ContainerManager) + creates the work-area record + dispatches `createWorktree(workAreaId, {branch,
   * shared})` to the daemon directly. So this port method is never the create path — loud reject if hit. */
  create(
    _input: NewWorkspace,
  ): Promise<{ workspace: Workspace; warning?: string }> {
    return this.unavailable('create');
  }

  remove(_id: string): Promise<void> {
    return this.worktreeCall('removeWorktree');
  }

  refreshFromBase(_id: string): Promise<BaseRefreshResult> {
    return this.worktreeCall('refreshFromBase');
  }

  mergeState(
    _workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    return this.worktreeCall('mergeState');
  }

  ensureShared(
    _id: string,
    name: string,
    startPoint?: string,
  ): Promise<string | undefined> {
    return this.worktreeCall('ensureShared', [name, startPoint]);
  }

  ensureSharedAtBase(
    _id: string,
    name: string,
  ): Promise<
    { ok: true; sharedBranch: string } | { ok: false; reason: string }
  > {
    return this.worktreeCall('ensureSharedAtBase', [name]);
  }

  sharedRef(_id: string): Promise<string | undefined> {
    return this.worktreeCall('sharedRef');
  }

  ownerDiff(
    _id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    return this.worktreeCall('ownerDiff', [sinceRef]);
  }

  publish(_id: string): Promise<IntegrationResult> {
    return this.worktreeCall('publish');
  }

  pull(_id: string): Promise<IntegrationResult> {
    return this.worktreeCall('pull');
  }

  pushSharedToOrigin(
    _id: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }> {
    return this.worktreeCall('pushSharedToOrigin');
  }

  // ── reference clones: the daemon resolves credentials itself, so the host `team` arg is dropped ──

  ensureReferenceClone(
    _team: string,
    target: { projectId: string } | { gitUrl: string },
  ): Promise<{ path: string; projectId?: string; gitUrl: string }> {
    return this.call('ensureReferenceClone', [target]);
  }

  /** Git-derived shared-branch status for list_workspaces — per-worktree (daemon keys off the session). */
  sharedStatus(
    _id: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined> {
    return this.worktreeCall('sharedStatus');
  }

  /** Orientation for an IN-SANDBOX reference-clone path — a path op (no session), like ensureReferenceClone. */
  referenceOrientation(path: string): Promise<string> {
    return this.call('referenceOrientation', [path]);
  }

  // ── host-only method (no daemon counterpart) — loud unavailable; containerized callers fork instead ──

  /** The single-repo daemon's clone IS the project, so there's no multi-project record to resolve. The
   * containerized review/ship/open_pr call sites fork on `isContainerized` and use the off-port daemon
   * ops (openPr/markReady/commentPr) rather than ever asking the daemon adapter for this. Loud reject. */
  projectRecordFor(_workspaceId: string): Promise<ProjectRecord | undefined> {
    return this.unavailable('projectRecordFor');
  }

  // ── off-port daemon ops (NOT on WorkspaceGitPort) — reached via WorkspaceGitProvider.daemonFor ──────

  /** The daemon computes the review diff-scope from ITS tree + the worktree's recorded cut sha (matches
   * the host `ticketRange` "diff since the cut point" semantics). No host `projectRecordFor`/`baseRef`. */
  reviewRange(): Promise<{ range: string; files: string[]; baseBranch: string }> {
    return this.worktreeCall('reviewRange');
  }

  /** Write the design artifact (a base64 zip) into the sandbox clone's `design/`. No session arg — the
   * daemon writes to the CLONE ROOT (the design gate has no engine session; see DaemonGitService). */
  attachDesign(
    artifactBase64: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.call('attachDesign', [artifactBase64]);
  }

  /** Open (or find) the workspace's PR — the daemon resolves repo/token/push itself (no host github). */
  openPr(args: {
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<PullRequestResult> {
    return this.call('openPr', [args]);
  }

  /** Flip the workspace's draft PR to ready-for-review (daemon-resolved repo/token). */
  markReady(prNumber: number): Promise<{ isDraft: boolean }> {
    return this.call('markReady', [prNumber]);
  }

  /** Post an advisory self-review comment on the workspace's PR (daemon-resolved repo/token). */
  commentPr(prNumber: number, body: string): Promise<void> {
    return this.call('commentPr', [prNumber, body]);
  }
}
