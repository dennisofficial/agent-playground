import { Injectable } from '@nestjs/common';
import { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
import { SandboxRegistry } from './sandbox-registry';
import { WorkspaceRegistry } from './workspace-registry';
import type { WorkspaceGitCtx, WorkspaceGitPort } from './workspace-git.port';

/**
 * The git-routing seam (Phase 8). `resolve(ctx)` returns the `WorkspaceGitPort` a consumer should run
 * its async git op against — the LOCAL host adapter today, the in-sandbox DAEMON adapter once Phase 9
 * flips `isContainerized` on. Every consumer that touched `WorkspaceService` for an async git method now
 * does `this.workspaceGit.resolve(ctx).<method>(...)` instead.
 *
 * Mirrors `TurnExecutor` (Phase 7), the engine-execution sibling seam:
 *   - `isContainerized(ctx)` is HARD-FALSE this phase (a clearly-marked Phase-9 seam). The live path is
 *     therefore 100% LOCAL — `resolve` always returns `LocalWorkspaceAdapter`, a pure pass-through to
 *     `WorkspaceService`, so runtime behavior is UNCHANGED after this phase.
 *   - the remote `DaemonGitAdapter` branch is built but DORMANT, exercised ONLY by unit tests via the
 *     test-only `isContainerized` override (same shape as `TestableTurnExecutor`).
 *
 * `resolve` is SYNCHRONOUS on purpose so call sites stay `resolve(ctx).method(...)` with no extra await.
 * The daemon adapter is keyed off `ctx.workspaceId` — the sandbox uuid for a containerized session
 * (Phase 0's identity decision: the renamed `workspace_id` holds `ws-NNN` locally, the sandbox uuid for
 * containerized sessions — one column, no second id).
 */
@Injectable()
export class WorkspaceGitProvider {
  constructor(
    private readonly local: LocalWorkspaceAdapter,
    private readonly daemon: DaemonClient,
    private readonly sandboxes: SandboxRegistry,
    private readonly workAreas: WorkspaceRegistry,
  ) {}

  /** The port to run `ctx`'s git op against — the in-sandbox daemon when `ctx`'s work area resolves to a
   * live sandbox, else the local host adapter. The daemon adapter is constructed PER-RESOLVE bound to the
   * `(sandboxId, workAreaId)` resolved via `WorkspaceRegistry` — so it substitutes the host workspace-id
   * arg with the daemon's per-worktree key (`workAreaId`) on each forwarded call (no session needed). */
  resolve(ctx: WorkspaceGitCtx): WorkspaceGitPort {
    const daemonAdapter = this.daemonFor(ctx);
    if (daemonAdapter) return daemonAdapter;
    // LOCAL — the pass-through adapter delegates verbatim to WorkspaceService.
    return this.local;
  }

  /**
   * The DAEMON adapter for a containerized ctx, or `undefined` when the op runs locally. The seam for the
   * OFF-PORT daemon ops (`reviewRange`/`attachDesign`/`openPr`/`markReady`/`commentPr`) — they're not on
   * `WorkspaceGitPort` (which must stay byte-for-byte mirrorable by `LocalWorkspaceAdapter`), so a
   * containerized call site that needs one forks on this: `const daemon = provider.daemonFor(ctx); if
   * (daemon) { …daemon ops… } else { …today's host github flow… }`. Returns the SAME `DaemonGitAdapter`
   * shape `resolve` produces on the containerized branch (bound to the sandbox uuid + ctx), so a daemon
   * op and the port ops a caller mixes address the same in-sandbox worktree.
   *
   * FLAG-OFF SAFETY: `isContainerized` is always false (no sandbox exists), so this always returns
   * `undefined` and every call site takes its unchanged local branch.
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
}
