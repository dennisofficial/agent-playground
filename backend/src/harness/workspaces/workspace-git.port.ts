import type { Session } from '../sessions/session-registry.port';
import type { ProjectRecord } from '../projects/project.types';
import type { BaseRefreshResult, IntegrationResult } from './workspace.types';

/**
 * The async GIT operations the harness invokes on a per-branch WORKSTATION — the routable seam. Every
 * call site goes through a port instance resolved by `WorkspaceGitProvider.resolve(ctx)`, which always
 * returns the in-sandbox `DaemonGitAdapter` (every workspace is a sandbox; there is no local path).
 *
 * THE WORKSTATION MODEL. A workspace is ONE branch the whole team commits to directly — no personal
 * branches, no `shared/<slug>` integration branch, no merge-convergence. Convergence is via origin
 * push (`publish`) / pull (`pull`); the PR is the feature branch → its UPSTREAM. So the port carries only
 * the per-branch ops the daemon's single checkout serves; the shared-branch ops (ensureShared/sharedRef/
 * pushSharedToOrigin/sharedStatus) and the local-only create/remove are GONE with the host workspace path.
 *
 * The `id`/`workspaceId` args are vestigial — the daemon's clone IS one branch, so its RPCs need no key —
 * but kept on the signatures so the call sites (which still hold a workspace handle) read unchanged.
 */
export interface WorkspaceGitPort {
  /** Bring the workstation branch up to date with its UPSTREAM (fetch + merge it in). */
  refreshFromBase(id: string): Promise<BaseRefreshResult>;

  /** Whether a merge is in progress in the workstation checkout, and the conflicted paths if so. */
  mergeState(
    workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }>;

  /** The git range + changed files isolating the branch's contribution since `sinceRef`. */
  ownerDiff(
    id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }>;

  /** Publish the workstation's committed work — push the branch to origin (the team syncs via origin). */
  publish(id: string): Promise<IntegrationResult>;

  /** Pull teammates' work into the workstation checkout — fetch + merge `origin/<branch>`. */
  pull(id: string): Promise<IntegrationResult>;

  /** The project record a workspace's remote ops run against (host-only — no daemon counterpart). */
  projectRecordFor(workspaceId: string): Promise<ProjectRecord | undefined>;

  /** Materialize / refresh a READ-ONLY reference clone of another repo. Returns the on-disk path. */
  ensureReferenceClone(
    team: string,
    target: { projectId: string } | { gitUrl: string },
  ): Promise<{ path: string; projectId?: string; gitUrl: string }>;

  /** A quick at-a-glance orientation (top level + README head) for a reference clone path. */
  referenceOrientation(path: string): Promise<string>;
}

/**
 * The minimal context needed to ROUTE a git op (host vs. in-sandbox). Deliberately not the full
 * `Session` — the workspace tools and `open_pr` route with only a `workspaceId`; the reference-clone
 * callers route with only `team`/`project`. `session` is carried when the caller has one (the daemon
 * keys the in-sandbox worktree off the harness session id, Phase 9). Mirrors `TurnRoutingCtx` (Phase 7)
 * so the two seams share the same routing vocabulary.
 */
export interface WorkspaceGitCtx {
  /** The tenant the op belongs to — used by the Phase-9 routing policy (registered project ⇒ sandbox). */
  team?: string;
  /** The project the op belongs to — used by the Phase-9 routing policy. */
  project?: string;
  /** The workspace the op targets, when the caller has a handle (`ws-NNN` local / sandbox uuid remote). */
  workspaceId?: string;
  /** The owning session, when the caller has one (review/self-review may not). */
  session?: Session;
}
