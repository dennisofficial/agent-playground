import { Injectable } from '@nestjs/common';
import { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { SandboxRegistry } from './sandbox-registry';
import { WorkspaceRegistry } from './workspace-registry';
import type { WorkspaceGitCtx, WorkspaceGitPort } from './workspace-git.port';

/**
 * The git-routing seam. `resolve(ctx)` returns the `WorkspaceGitPort` a consumer runs its async git op
 * against — always the in-sandbox `DaemonGitAdapter` (every workspace is a sandbox work area; there is no
 * local path). The adapter is constructed PER-RESOLVE bound to the `(sandboxId, workAreaId)` resolved via
 * `WorkspaceRegistry`, so it substitutes the host workspace-id arg with the daemon's per-worktree key
 * (`workAreaId`) on each forwarded call (no session needed).
 *
 * `resolve` is SYNCHRONOUS so call sites stay `resolve(ctx).method(...)` with no extra await; it THROWS
 * when the ctx's work area doesn't resolve to a live sandbox (a routing bug / orphaned work area).
 */
@Injectable()
export class WorkspaceGitProvider {
  constructor(
    private readonly daemon: DaemonClient,
    private readonly sandboxes: SandboxRegistry,
    private readonly workAreas: WorkspaceRegistry,
  ) {}

  /** The port to run `ctx`'s git op against — the in-sandbox daemon adapter for the ctx's work area.
   * Throws if the work area doesn't resolve to a live sandbox (its sandbox is gone / not a work area). */
  resolve(ctx: WorkspaceGitCtx): WorkspaceGitPort {
    const daemonAdapter = this.daemonFor(ctx);
    if (!daemonAdapter) {
      throw new Error(
        `No live sandbox for workspace "${this.workAreaId(ctx) ?? '(none)'}" — its work area or sandbox is gone.`,
      );
    }
    return daemonAdapter;
  }

  /**
   * The DAEMON adapter for `ctx`'s work area, or `undefined` when it doesn't resolve to a live sandbox.
   * Also the seam for the OFF-PORT daemon ops (`reviewRange`/`attachDesign`/`openPr`/`markReady`/
   * `commentPr`) — not on `WorkspaceGitPort`; a call site that needs one does `const d =
   * provider.daemonFor(ctx); if (d) { …daemon ops… }`. Same `DaemonGitAdapter` `resolve` returns.
   */
  daemonFor(ctx: WorkspaceGitCtx): DaemonGitAdapter | undefined {
    const workAreaId = this.workAreaId(ctx);
    if (!workAreaId) return undefined;
    const sandboxId = this.workAreas.sandboxIdFor(workAreaId);
    if (!sandboxId || !this.sandboxes.has(sandboxId)) return undefined;
    return new DaemonGitAdapter(this.daemon, sandboxId, workAreaId);
  }

  /** The work area a ctx addresses — the session's workspace (the session belongs to a work area) else
   * the ctx's workspace handle. Both hold the `workAreaId` (`session.workspace_id` is the workAreaId). */
  private workAreaId(ctx: WorkspaceGitCtx): string | undefined {
    return ctx.session?.workspaceId ?? ctx.workspaceId;
  }

  /**
   * The routing POLICY — whether this git op runs inside an isolated sandbox.
   *
   * THE DISCRIMINATOR (identical to `TurnExecutor.isContainerized`): the op's `workAreaId` resolves
   * through `WorkspaceRegistry` to a sandbox that is LIVE in `SandboxRegistry`. `create_workspace` stamped
   * the work area's `workAreaId` onto the session's `workspace_id` and registered it → this reads that
   * back. The two seams (turn + git) share the predicate so a session's turns and git ops route together.
   *
   * PUBLIC so a containerized call site can fork its own host-vs-daemon branch on the SAME discriminator
   * the provider routes on (e.g. ReviewPipelineService's review/ship barrier, open_pr) before deciding
   * whether to use `daemonFor(ctx)` or its unchanged host github flow.
   */
  public isContainerized(ctx: WorkspaceGitCtx): boolean {
    return this.daemonFor(ctx) !== undefined;
  }

  /**
   * Resolve a LIVE work area to materialize a team/project-scoped read into (a reference clone). The
   * reference tools (`reference_project`/`reference_repo`/`investigate({references})`) have no workspace
   * handle of their own, so they route the read-only clone through an EXISTING live workstation:
   *   - an explicit `workspaceId` wins (the investigate session's own work area);
   *   - else the bot's OWN live area for `(team, project)`, newest first;
   *   - else ANY live area for `(team, project)` — boot-reconciled areas carry `ownerBot: ''`, so an
   *     owner-only match would miss a perfectly good workstation.
   * Returns the bound port + the work area it resolved to, or `undefined` when none is live. We NEVER
   * auto-create here — the caller turns `undefined` into create_workspace guidance.
   */
  resolveReferenceTarget(sel: {
    team: string;
    project?: string;
    ownerBot?: string;
    workspaceId?: string;
  }): { workspaceId: string; port: WorkspaceGitPort } | undefined {
    if (sel.workspaceId) {
      const port = this.daemonFor({ workspaceId: sel.workspaceId });
      return port ? { workspaceId: sel.workspaceId, port } : undefined;
    }
    const areas = this.workAreas.list({ team: sel.team, project: sel.project });
    const own = sel.ownerBot
      ? areas.filter((a) => a.ownerBot === sel.ownerBot)
      : [];
    const rest = areas.filter((a) => !own.includes(a));
    // Newest first within each tier (registry is insertion-ordered), bot's own preferred.
    for (const a of [...own.reverse(), ...rest.reverse()]) {
      const port = this.daemonFor({ workspaceId: a.workAreaId });
      if (port) return { workspaceId: a.workAreaId, port };
    }
    return undefined;
  }
}
