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
  /** The project's GitHub repo URL (label `com.agent.repo`) — informational/diagnostic. */
  repo: string;
  /** The Docker container id backing this workspace. */
  containerId: string;
  status: SandboxStatus;
  /** The short random bootstrap token issued to this sandbox — the cred-channel auth secret. NOT a
   * label (a label is world-readable via `docker inspect`); known only in-process and re-issued on the
   * sandbox's next (re)create. Undefined for a container ADOPTED on boot (the original token was never
   * persisted — a re-adopted sandbox can't serve creds until it's recreated; documented limitation). */
  bootstrapToken?: string;
}

/** What `resolveForSession` needs to key + create a workspace — the session's tenancy. */
export interface SessionScope {
  team: string;
  project: string;
}

/** The lazy ensure-the-sandbox callback the manager registers (one-directional DI: Manager → Registry). */
export type EnsureWorkspaceFn = (
  team: string,
  project: string,
) => Promise<SandboxRecord>;

/**
 * The in-memory map of `workspaceId ↔ SandboxRecord` (Phase 6). Rebuilt on boot by
 * `ContainerManagerService` from Docker labels; this registry itself is not durable.
 *
 * SCOPING (v1, documented): one workspace per `(team, project)`. The plan's end-state is one workspace
 * per UNIT OF WORK (per task), but Phase 6 has no session-lifecycle wiring yet (that's Phase 9), so
 * there's no task id to key on here. `(team, project)` is the coarsest correct key that still isolates
 * tenants + projects; Phase 9 narrows it to per-task by passing a richer scope into `workspaceKey`.
 * The KEY is logical (`<team>/<project>`); the workspace ID is the container's uuid — the registry maps
 * the logical key to the uuid so two calls for the same `(team, project)` reuse the same sandbox.
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
  /** logical `<team>/<project>` key → workspaceId (uuid). */
  private readonly byKey = new Map<string, string>();
  private ensurer?: EnsureWorkspaceFn;

  /** The v1 scoping key: one workspace per `(team, project)`. Documented above. */
  workspaceKey(scope: SessionScope): string {
    return `${scope.team}/${scope.project}`;
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
   * Resolve the sandbox for a session's `(team, project)`: return the existing record, else lazily
   * `ensureWorkspace` (create + start the container). Phase 7's `RemoteTurnDispatcher` calls this to get
   * the `workspaceId` to dispatch a run to.
   */
  async resolveForSession(scope: SessionScope): Promise<SandboxRecord> {
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
    return this.ensurer(scope.team, scope.project);
  }
}
