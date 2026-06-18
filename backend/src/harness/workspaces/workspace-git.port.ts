import type { Session } from '../sessions/session-registry.port';
import type { ProjectRecord } from '../projects/project.types';
import type {
  BaseRefreshResult,
  IntegrationResult,
  NewWorkspace,
  Workspace,
} from './workspace.types';

/**
 * The async GIT operations the harness invokes on a workspace — the routable seam (Phase 8). Every
 * call site that today calls `WorkspaceService.<asyncGitMethod>(...)` goes through a port instance
 * resolved by `WorkspaceGitProvider.resolve(ctx)` instead, so a containerized session (Phase 9) runs
 * the SAME operation inside its sandbox over the daemon RPC rather than on the host.
 *
 * SCOPE — this is ONLY the async git surface. The SYNC registry lookups (`get`/`list`/`workerRoot`/
 * `reposRoot`/`sharedBranchName`) deliberately stay on `WorkspaceService` directly: they're cheap
 * in-memory reads, and nothing is containerized this phase (Phase 9 gates their use for sandboxed
 * sessions). Method signatures here MATCH `WorkspaceService` EXACTLY so `LocalWorkspaceAdapter` is a
 * pure 1:1 pass-through (byte-identical runtime behavior).
 *
 * Two adapters implement it:
 *  - `LocalWorkspaceAdapter` — delegates each method verbatim to the host `WorkspaceService` (the only
 *    path that runs this phase; `isContainerized` is hard-false until Phase 9).
 *  - `DaemonGitAdapter` — DORMANT this phase; forwards each call as a typed git RPC to the in-sandbox
 *    daemon over Redis (`DaemonClient.gitCall`). Built + unit-tested, never reached at runtime yet.
 */
export interface WorkspaceGitPort {
  /** Create a workspace (cut a branch off the project repo, optionally joining a shared branch). */
  create(
    input: NewWorkspace,
  ): Promise<{ workspace: Workspace; warning?: string }>;

  /** Remove a workspace's checkout (the branch + its commits survive). */
  remove(id: string): Promise<void>;

  /** Bring a workspace's branch up to date with its project's base branch. */
  refreshFromBase(id: string): Promise<BaseRefreshResult>;

  /** Whether a merge is in progress in the workspace, and the conflicted paths if so. */
  mergeState(
    workspaceId: string,
  ): Promise<{ inProgress: boolean; files: string[] }>;

  /** Promote a workspace to a shared integration branch (cut at the branch tip) if not already on one. */
  ensureShared(
    id: string,
    name: string,
    startPoint?: string,
  ): Promise<string | undefined>;

  /** Promote a workspace with existing owner commits to a shared branch, cut at the base divergence. */
  ensureSharedAtBase(
    id: string,
    name: string,
  ): Promise<{ ok: true; sharedBranch: string } | { ok: false; reason: string }>;

  /** The current tip sha of a workspace's shared integration branch (for the self-review diff base). */
  sharedRef(id: string): Promise<string | undefined>;

  /** The git range + changed files isolating an owner's own contribution since `sinceRef`. */
  ownerDiff(
    id: string,
    sinceRef: string,
  ): Promise<{ range: string; files: string[] }>;

  /** Publish a workspace's committed work onto its shared integration branch (+ origin sync). */
  publish(id: string): Promise<IntegrationResult>;

  /** Merge the shared integration branch into a workspace (take teammates' published work). */
  pull(id: string): Promise<IntegrationResult>;

  /** Push a workspace's shared branch to its project's registered repo (the open_pr push). */
  pushSharedToOrigin(
    id: string,
  ): Promise<{ sharedBranch: string; gitUrl: string }>;

  /** The project record a workspace's remote ops run against (origin-URL recovery included). */
  projectRecordFor(workspaceId: string): Promise<ProjectRecord | undefined>;

  /** Git-derived shared-branch status for list_workspaces (published? commits not on origin?). */
  sharedStatus(
    id: string,
  ): Promise<{ published: boolean; aheadOfOrigin?: number } | undefined>;

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
