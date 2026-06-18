import type { PullRequestResult } from '../projects/github-api.service';
import type { ProjectRecord } from '../projects/project.types';
import type {
  BaseRefreshResult,
  IntegrationResult,
  NewWorkspace,
  Workspace,
} from './workspace.types';
import type { WorkspaceGitCtx, WorkspaceGitPort } from './workspace-git.port';
import type { DaemonClient } from './daemon-client';

/**
 * The REMOTE `WorkspaceGitPort` — forwards each git op to the in-sandbox daemon's `DaemonGitService`
 * over Redis (the Phase-5 typed git RPC: `DaemonClient.gitCall(workspaceId, method, args)`), returning
 * the daemon's result.
 *
 * THE HOST↔DAEMON IDENTITY MAPPING (Phase 9 — the crux):
 *   - The HOST `WorkspaceGitPort` is keyed by the host `workspaceId` (here = the SANDBOX uuid).
 *   - The daemon's `DaemonGitService` keys per-WORKTREE ops by the HARNESS SESSION ID — one sandbox
 *     (one repo) hosts MANY worktrees, one per session (`agent/<sessionId>` under `.workspaces/`).
 *   So for every per-worktree method we DROP the host workspace-id arg and SUBSTITUTE `ctx.session.id`
 *   (the daemon's worktree key) as the daemon method's leading arg. `RemoteTurnDispatcher` (Phase 7)
 *   keys the engine cwd off the SAME `ctx.session.id` (its `RunCommandPayload.sessionId`), so a turn's
 *   cwd and its git ops always address the SAME in-sandbox worktree.
 *
 * Constructed PER-RESOLVE by `WorkspaceGitProvider.resolve(ctx)`, bound to the sandbox uuid (the RPC
 * dispatch target) AND the resolving `ctx` (the source of the session worktree key). DORMANT until
 * `WORKSPACE_SANDBOX_ENABLED` lets a sandbox exist; exercised by unit tests with a fake `DaemonClient`.
 *
 * `sharedStatus` + `referenceOrientation` now route to real daemon RPCs (the daemon computes them from
 * ITS tree / an in-sandbox reference clone). ONE host port method has NO daemon counterpart by design:
 * `projectRecordFor` — a HOST-REGISTRY / multi-project read the single-repo daemon doesn't model (its
 * clone IS the project, by construction). It stays a loud `unavailable()` rejection so a mis-route
 * surfaces; the containerized callers that used to need it (the review/ship barrier, open_pr) now FORK
 * at the call site on `WorkspaceGitProvider.isContainerized` and use the off-port daemon ops below
 * instead, so they never ask the daemon adapter for `projectRecordFor`.
 *
 * OFF-PORT DAEMON OPS (`reviewRange`/`attachDesign`/`openPr`/`markReady`/`commentPr`): these are NOT on
 * `WorkspaceGitPort` (which must stay byte-for-byte mirrorable by the pure-pass-through
 * `LocalWorkspaceAdapter`). They're daemon-only — the host's containerized branch reaches them via
 * `WorkspaceGitProvider.daemonFor(ctx)` (which narrows the port to a `DaemonGitAdapter`). The daemon is
 * self-sufficient for them: it owns its repo + base + the GitHub credential, so `openPr`/`markReady`/
 * `commentPr` need no host project record / token, and `reviewRange` needs no host `baseRef`.
 */
export class DaemonGitAdapter implements WorkspaceGitPort {
  constructor(
    private readonly daemon: DaemonClient,
    /** The sandbox the git RPCs dispatch to (`DaemonClient.gitCall`'s first arg). */
    private readonly workspaceId: string,
    /** The resolving ctx — its `session.id` is the daemon's per-worktree key (the identity mapping). */
    private readonly ctx: WorkspaceGitCtx,
  ) {}

  /** Dispatch one `DaemonGitService` method as a typed git RPC and return its (typed) result. */
  private call<T>(method: string, args: unknown[]): Promise<T> {
    return this.daemon.gitCall(this.workspaceId, method, args) as Promise<T>;
  }

  /** Dispatch a per-worktree method: substitute the host workspace-id arg with the daemon's worktree key
   * (`ctx.session.id`) and prepend it to `rest`. Surfaces a missing session as a REJECTED promise (the
   * methods are async-contract — a caller's `await`/`.catch()` must see it, not a sync throw). A
   * containerized git op without a session is a routing bug (the session IS the worktree). */
  private worktreeCall<T>(method: string, rest: unknown[] = []): Promise<T> {
    const sessionId = this.ctx.session?.id;
    if (!sessionId) {
      return Promise.reject(
        new Error(
          'DaemonGitAdapter: a per-worktree git op needs ctx.session (the daemon keys the worktree off the harness session id).',
        ),
      );
    }
    return this.call<T>(method, [sessionId, ...rest]);
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

  /** create_workspace's git side. In a sandbox the worktree is the session's; the daemon cuts it keyed
   * by session id (NewWorkspace's name/branch/shared aren't the daemon's per-worktree primitive — the
   * shared branch is established later via ensureShared). Returns a Workspace shell the tool reads. */
  create(
    _input: NewWorkspace,
  ): Promise<{ workspace: Workspace; warning?: string }> {
    return this.worktreeCall('createWorktree');
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
