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
 * THE HOST↔DAEMON IDENTITY MAPPING (the WORKSTATION model):
 *   - The RPC dispatch target is the SANDBOX uuid (`sandboxId`) — the container's command stream.
 *   - A sandbox IS one fresh clone checked out on ONE branch (the per-branch WORKSTATION). There are no
 *     inner worktrees and no per-worktree key: every per-branch git op runs in that single checkout, so
 *     the daemon's per-branch RPCs (`publish`/`pull`/`refreshFromBase`/`mergeState`/`ownerDiff`/
 *     `reviewRange`) take NO leading id arg — the daemon already knows its one branch. `RemoteTurnDispatcher`
 *     keys the engine cwd off the SAME `workAreaId` (its `RunCommandPayload.workAreaId`), so a turn's cwd
 *     and its git ops always address the SAME checkout. The host `workspaceId` arg the port methods carry is
 *     vestigial here (the daemon needs no key) and simply dropped.
 *
 * Constructed PER-RESOLVE by `WorkspaceGitProvider.resolve(ctx)`, bound to the `(sandboxId, workAreaId)`
 * the provider resolved via `WorkspaceRegistry`. Exercised by unit tests with a fake `DaemonClient`.
 *
 * `referenceOrientation` routes to a real daemon RPC. ONE host port method has NO daemon counterpart by
 * design: `projectRecordFor` — a HOST-REGISTRY / multi-project read the single-repo daemon doesn't model
 * (its clone IS the project). It stays a loud `unavailable()` rejection; containerized callers that used to
 * need it (review/ship, open_pr) FORK on `WorkspaceGitProvider.isContainerized` and use the off-port daemon
 * ops below instead.
 *
 * OFF-PORT DAEMON OPS (`reviewRange`/`attachDesign`/`openPr`/`markReady`/`commentPr`): NOT on
 * `WorkspaceGitPort`. They're daemon-only — reached via `WorkspaceGitProvider.daemonFor(ctx)`. The daemon
 * is self-sufficient for them (it owns its repo + branch + the GitHub credential).
 */
export class DaemonGitAdapter implements WorkspaceGitPort {
  constructor(
    private readonly daemon: DaemonClient,
    /** The sandbox the git RPCs dispatch to (`DaemonClient.gitCall`'s first arg = the container id). */
    private readonly sandboxId: string,
    /** The work area the engine cwd keys off (1:1 with the sandbox's single checkout). The daemon's
     * per-branch RPCs need no id arg — the workstation IS one branch — so this is unused by the git RPCs
     * here, kept for parity with `RemoteTurnDispatcher` (the turn seam keys cwd off the same id). */
    private readonly workAreaId: string,
  ) {}

  /** Dispatch one `DaemonGitService` method as a typed git RPC and return its (typed) result. */
  private call<T>(method: string, args: unknown[] = []): Promise<T> {
    return this.daemon.gitCall(this.sandboxId, method, args) as Promise<T>;
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

  // ── per-branch methods: the daemon's single checkout IS the branch → no leading id arg ───────────
  // The host `workspaceId` the port carries is vestigial here (the daemon needs no key) and dropped.

  refreshFromBase(_id: string): Promise<BaseRefreshResult> {
    return this.call('refreshFromBase');
  }

  mergeState(
    _workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }> {
    return this.call('mergeState');
  }

  ownerDiff(
    _id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }> {
    return this.call('ownerDiff', [sinceRef]);
  }

  publish(_id: string): Promise<IntegrationResult> {
    return this.call('publish');
  }

  pull(_id: string): Promise<IntegrationResult> {
    return this.call('pull');
  }

  // ── reference clones: the daemon resolves credentials itself, so the host `team` arg is dropped ──

  ensureReferenceClone(
    _team: string,
    target: { projectId: string } | { gitUrl: string },
  ): Promise<{ path: string; projectId?: string; gitUrl: string }> {
    return this.call('ensureReferenceClone', [target]);
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

  /** The daemon computes the review diff-scope from ITS single checkout: the branch since its merge-base
   * with the upstream (matches the host `ticketRange` "diff since the cut point" semantics). No host
   * `projectRecordFor`/`baseRef` and no id arg — the workstation IS one branch. */
  reviewRange(): Promise<{ range: string; files: string[]; baseBranch: string }> {
    return this.call('reviewRange');
  }

  /** Write the design artifact (a base64 zip) into the sandbox clone's `design/`. No session arg — the
   * daemon writes to the CLONE ROOT (the design gate has no engine session; see DaemonGitService). */
  attachDesign(
    artifactBase64: string,
  ): Promise<{ ok: boolean; message: string }> {
    return this.call('attachDesign', [artifactBase64]);
  }

  /** Open (or find) the workstation's PR — the daemon resolves repo/token/push itself (no host github). */
  openPr(args: {
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<PullRequestResult> {
    return this.call('openPr', [args]);
  }

  /** Flip the workstation's draft PR to ready-for-review (daemon-resolved repo/token). */
  markReady(prNumber: number): Promise<{ isDraft: boolean }> {
    return this.call('markReady', [prNumber]);
  }

  /** Post an advisory self-review comment on the workstation's PR (daemon-resolved repo/token). */
  commentPr(prNumber: number, body: string): Promise<void> {
    return this.call('commentPr', [prNumber, body]);
  }
}
