import { Injectable, Logger } from '@nestjs/common';

/**
 * One WORK AREA — the per-task unit the workspace tools address (`workAreaId` = `wa-<uuid>`). A work area
 * is a branch/worktree INSIDE a sandbox; the SESSIONS in it share that worktree. This is the host's
 * durable-ish record of the work area's metadata (name/branch/shared/owner) + which sandbox it lives in.
 *
 * THE THREE-TIER MODEL this keys into:
 *   sandbox (per team/project, `SandboxRegistry`) ⊃ work area (per task, HERE) ⊃ sessions (share the worktree).
 *
 * The branch/shared values are INTENT recorded at create time; the daemon owns the realized git state
 * (`DaemonGitService.describeWorktrees` is the durable source — this registry reconciles from it on boot).
 */
export interface WorkAreaRecord {
  /** `wa-<uuid>` — the workspace id the tools take and `session.workspace_id` holds. */
  workAreaId: string;
  /** The sandbox (container) this work area lives in — the RPC/turn dispatch target. */
  sandboxId: string;
  team: string;
  project: string;
  /** The employee-supplied short name (display + slugified into the branch). */
  name: string;
  /** The work area's git branch (intent; realized by the daemon). */
  branch?: string;
  /** The shared integration branch this work area publishes to / pulls from, if joined. */
  shared?: string;
  /** The employee that created it ('' when reconciled from git, where ownership isn't recorded). */
  ownerBot: string;
}

/** Filter for `list` — narrow to a tenant/project/owner (mirrors `WorkspaceService.list`'s shape). */
export interface WorkAreaFilter {
  team?: string;
  project?: string;
  ownerBot?: string;
}

/**
 * The host's in-memory `workAreaId ↔ WorkAreaRecord` map (the three-tier model's middle tier). Populated
 * at `create_workspace`; reconciled on boot from each sandbox's `describeWorktrees` (durable git state),
 * mirroring how `SandboxRegistry` rebuilds from Docker labels. Not itself durable — git + the sandboxes
 * are the source of truth.
 *
 * The routing seams (`TurnExecutor`/`WorkspaceGitProvider`) resolve `workAreaId → sandboxId` HERE, then
 * check the sandbox is live in `SandboxRegistry` — so `session.workspace_id` (now a workAreaId) routes to
 * the right container. The `WorkspaceReader` assembles the agent-facing view from this + sessions + the
 * daemon's live worktree state.
 */
@Injectable()
export class WorkspaceRegistry {
  private readonly logger = new Logger(WorkspaceRegistry.name);
  private readonly byId = new Map<string, WorkAreaRecord>();

  upsert(record: WorkAreaRecord): void {
    this.byId.set(record.workAreaId, record);
  }

  get(workAreaId: string): WorkAreaRecord | undefined {
    return this.byId.get(workAreaId);
  }

  has(workAreaId: string): boolean {
    return this.byId.has(workAreaId);
  }

  /** The sandbox a work area lives in — THE routing resolution (`workAreaId → sandboxId`). */
  sandboxIdFor(workAreaId: string): string | undefined {
    return this.byId.get(workAreaId)?.sandboxId;
  }

  remove(workAreaId: string): void {
    this.byId.delete(workAreaId);
  }

  list(filter?: WorkAreaFilter): WorkAreaRecord[] {
    let out = [...this.byId.values()];
    if (filter?.team) out = out.filter((w) => w.team === filter.team);
    if (filter?.project) out = out.filter((w) => w.project === filter.project);
    if (filter?.ownerBot) out = out.filter((w) => w.ownerBot === filter.ownerBot);
    return out;
  }

  /** Drop every work area belonging to a sandbox (the sandbox was destroyed/reconciled away). */
  removeForSandbox(sandboxId: string): void {
    for (const [id, rec] of this.byId) {
      if (rec.sandboxId === sandboxId) this.byId.delete(id);
    }
  }

  /**
   * Reconcile this sandbox's work areas from the daemon's durable worktree view (boot recovery — the
   * in-memory map is empty after a harness restart, but the daemon re-adopted its worktrees from git).
   * `name` falls back to the workAreaId and `ownerBot` to '' since the daemon doesn't record them — the
   * branch/shared (the load-bearing git facts) are recovered exactly. Replaces this sandbox's records.
   */
  reconcileFromWorktrees(
    sandboxId: string,
    team: string,
    project: string,
    worktrees: Array<{ workAreaId: string; branch?: string; shared?: string }>,
  ): void {
    this.removeForSandbox(sandboxId);
    for (const w of worktrees) {
      this.upsert({
        workAreaId: w.workAreaId,
        sandboxId,
        team,
        project,
        name: w.workAreaId,
        ownerBot: '',
        ...(w.branch ? { branch: w.branch } : {}),
        ...(w.shared ? { shared: w.shared } : {}),
      });
    }
    this.logger.log(
      `reconciled ${worktrees.length} work area(s) for sandbox ${sandboxId} (${team}/${project})`,
    );
  }

  clear(): void {
    this.byId.clear();
  }
}
