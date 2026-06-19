import { Injectable, Logger } from '@nestjs/common';

/** A sandbox's lifecycle status as the host tracks it (mirrors the Docker container state we care about). */
export type SandboxStatus = 'starting' | 'running' | 'stopped' | 'gone';

/** The host's in-memory record of one workspace sandbox. Rebuilt on boot from Docker labels by
 * `ContainerManagerService` (Docker is the durable store; this registry is not). */
export interface SandboxRecord {
  /** The workspace id = the sandbox's uuid (the `agent-ws-<uuid>` name's uuid, and the exposure key). */
  workspaceId: string;
  team: string;
  project: string;
  /** The git branch this per-branch sandbox (workstation) lives on — the KEY differentiator now that a
   * sandbox is keyed `(team, project, branch)`. Label `com.agent.branch`; injected as `WORKSPACE_BRANCH`
   * so the daemon checks it out at boot. '' on a sandbox that predates per-branch identity. */
  branch: string;
  /** What the branch is cut FROM when it doesn't yet exist (label `com.agent.base-ref`, env
   * `WORKSPACE_BASE_REF`). Survives a restart so the daemon can still create the branch from the right ref. */
  baseRef: string;
  /** Where the branch refreshes-from / opens its PR INTO (label `com.agent.upstream`, env
   * `WORKSPACE_UPSTREAM`). */
  upstream: string;
  /** The project's GitHub repo URL (label `com.agent.repo`) — informational/diagnostic. */
  repo: string;
  /** The Docker container id backing this workspace. */
  containerId: string;
  status: SandboxStatus;
  /** The short random bootstrap token issued to this sandbox — the cred-channel auth secret. Persisted
   * as the `com.agent.boot-token` container label (the single deliberate secret-on-a-label tradeoff — see
   * ContainerManagerService.LABEL_BOOT_TOKEN; it's only the cred-channel auth, NOT the GitHub PAT / LLM
   * key) so a sandbox re-adopted on boot recovers it from the label and keeps serving the cred-pull.
   * Undefined only for a sandbox created before the label existed (or with the label stripped) — its
   * cred-req then gets a clean rejection until recreate. */
  bootstrapToken?: string;
}

/** What `resolveForSession`/`find` need to key a workstation — the session's tenancy AND its branch (a
 * sandbox is now per-branch: `(team, project, branch)`). */
export interface SessionScope {
  team: string;
  project: string;
  /** The git branch this workstation is on — the per-branch sandbox key. */
  branch: string;
}

/** The lazy ensure-the-sandbox callback the manager registers (one-directional DI: Manager → Registry). */
export type EnsureWorkspaceFn = (
  team: string,
  project: string,
  branch: string,
  baseRef: string,
  upstream: string,
) => Promise<SandboxRecord>;

/**
 * The in-memory map of `workspaceId ↔ SandboxRecord` (Phase 6). Rebuilt on boot by
 * `ContainerManagerService` from Docker labels; this registry itself is not durable.
 *
 * SCOPING: one WORKSTATION (sandbox) per `(team, project, branch)` — long-lived, re-entered by branch.
 * The KEY is logical (`<team>/<project>/<branch>`); the workspace ID is the container's uuid — the
 * registry maps the logical key to the uuid so two `create_workspace` calls deriving the SAME branch
 * reuse the same workstation (idempotent re-entry).
 *
 * To avoid a DI cycle with `ContainerManagerService` (which both WRITES records here on create/reconcile
 * AND is the thing `resolveForSession` must call to lazily create) the manager registers its
 * `ensureWorkspace` via `bindEnsurer` at construction — so DI flows one way (Manager → Registry) and the
 * registry calls back through the bound function, not an injected manager.
 */
@Injectable()
export class SandboxRegistry {
  private readonly logger = new Logger(SandboxRegistry.name);
  private readonly byWorkspaceId = new Map<string, SandboxRecord>();
  /** logical `<team>/<project>/<branch>` key → workspaceId (uuid). */
  private readonly byKey = new Map<string, string>();
  private ensurer?: EnsureWorkspaceFn;

  /** The scoping key: one workstation per `(team, project, branch)`. Documented above. */
  workspaceKey(scope: SessionScope): string {
    return `${scope.team}/${scope.project}/${scope.branch}`;
  }

  /** The manager binds its lazy-create entry point here at construction (breaks the DI cycle). */
  bindEnsurer(fn: EnsureWorkspaceFn): void {
    this.ensurer = fn;
  }

  /** Upsert a record (manager calls this on create + on boot reconcile). Re-keys the logical index. */
  upsert(record: SandboxRecord): void {
    this.byWorkspaceId.set(record.workspaceId, record);
    this.byKey.set(this.workspaceKey(record), record.workspaceId);
  }

  /** Drop a record (manager calls this on destroy). */
  remove(workspaceId: string): void {
    const rec = this.byWorkspaceId.get(workspaceId);
    if (!rec) return;
    this.byWorkspaceId.delete(workspaceId);
    if (this.byKey.get(this.workspaceKey(rec)) === workspaceId) {
      this.byKey.delete(this.workspaceKey(rec));
    }
  }

  /** Clear every record (manager calls this before a full boot reconcile rebuild). */
  clear(): void {
    this.byWorkspaceId.clear();
    this.byKey.clear();
  }

  get(workspaceId: string): SandboxRecord | undefined {
    return this.byWorkspaceId.get(workspaceId);
  }

  /**
   * Whether `workspaceId` is a live sandbox — THE Phase-9 routing discriminator. A session/workspace is
   * containerized IFF its `workspaceId` is a sandbox uuid this registry knows. `TurnExecutor` and
   * `WorkspaceGitProvider` both gate `isContainerized` on this: the local `ws-NNN` ids never appear here
   * (they're managed by `WorkspaceService`), so every local session reads false. The create-time policy
   * already decided sandbox-vs-local; routing just consults the resulting registry presence.
   */
  has(workspaceId: string): boolean {
    return this.byWorkspaceId.has(workspaceId);
  }

  /** The record for a `(team, project)`, if a sandbox already exists for it (no create). */
  find(scope: SessionScope): SandboxRecord | undefined {
    const id = this.byKey.get(this.workspaceKey(scope));
    return id ? this.byWorkspaceId.get(id) : undefined;
  }

  list(): SandboxRecord[] {
    return [...this.byWorkspaceId.values()];
  }

  /**
   * The cred-channel auth lookup: the bootstrap token THIS host issued for a workspace, or undefined if
   * the workspace is unknown or was adopted on boot (no token to validate against — the request is then
   * rejected; the sandbox must be recreated to get a fresh token).
   */
  bootstrapToken(workspaceId: string): string | undefined {
    return this.byWorkspaceId.get(workspaceId)?.bootstrapToken;
  }

  /**
   * Resolve the workstation for a session's `(team, project, branch)`: return the existing record, else
   * lazily `ensureWorkspace` (create + start the container). The branch's `baseRef`/`upstream` are needed
   * to create the workstation, so they're carried on the scope (a re-entry reuses the existing one, so they
   * only matter on a fresh create).
   */
  async resolveForSession(
    scope: SessionScope & { baseRef?: string; upstream?: string },
  ): Promise<SandboxRecord> {
    const existing = this.find(scope);
    if (existing && existing.status !== 'gone') return existing;
    if (!this.ensurer) {
      throw new Error(
        'SandboxRegistry: no ensurer bound — ContainerManagerService must register one at boot.',
      );
    }
    this.logger.log(
      `no live sandbox for ${this.workspaceKey(scope)} — ensuring one`,
    );
    return this.ensurer(
      scope.team,
      scope.project,
      scope.branch,
      scope.baseRef ?? scope.branch,
      scope.upstream ?? scope.branch,
    );
  }
}
