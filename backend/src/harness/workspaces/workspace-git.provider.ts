import { Injectable } from '@nestjs/common';
import { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
import { SandboxRegistry } from './sandbox-registry';
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
  ) {}

  /** The port to run `ctx`'s git op against — local host today, in-sandbox daemon once a workspace is
   * a live sandbox. The daemon adapter is constructed PER-RESOLVE bound to the sandbox uuid AND the ctx,
   * so it can substitute the host workspace-id arg with the daemon's per-worktree key (`ctx.session.id`)
   * on each forwarded call (the host↔daemon identity mapping). */
  resolve(ctx: WorkspaceGitCtx): WorkspaceGitPort {
    if (this.isContainerized(ctx)) {
      // The sandbox to dispatch to: the session's/ctx's workspace id (= the sandbox uuid for a
      // containerized run). Required on the remote path — without it there's no container to reach.
      const workspaceId = this.sandboxId(ctx);
      if (!workspaceId) {
        throw new Error(
          'WorkspaceGitProvider: a containerized git op needs a workspaceId (the sandbox to dispatch to).',
        );
      }
      return new DaemonGitAdapter(this.daemon, workspaceId, ctx);
    }
    // LOCAL — today's path. The pass-through adapter delegates verbatim to WorkspaceService.
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
    if (!this.isContainerized(ctx)) return undefined;
    const workspaceId = this.sandboxId(ctx);
    if (!workspaceId) {
      throw new Error(
        'WorkspaceGitProvider: a containerized daemon op needs a workspaceId (the sandbox to dispatch to).',
      );
    }
    return new DaemonGitAdapter(this.daemon, workspaceId, ctx);
  }

  /** The candidate sandbox id for a ctx — the session's workspace (preferred: the session is the unit a
   * sandbox hosts) else the ctx's workspace handle. Both hold the sandbox uuid for a containerized run. */
  private sandboxId(ctx: WorkspaceGitCtx): string | undefined {
    return ctx.session?.workspaceId ?? ctx.workspaceId;
  }

  /**
   * The routing POLICY — whether this git op runs inside an isolated sandbox (Phase 9).
   *
   * THE DISCRIMINATOR (identical to `TurnExecutor.isContainerized`): the op's workspace id is a LIVE
   * SANDBOX, i.e. `SandboxRegistry.has(workspaceId)`. The create-time policy already decided sandbox vs
   * local and stamped it as the session's `workspace_id`; this just reads it back. No project/engine
   * re-check at routing time. The two seams (turn + git) share the predicate so a session's turns and
   * git ops always route together.
   *
   * FLAG-OFF SAFETY: `WORKSPACE_SANDBOX_ENABLED` false ⇒ no sandbox is ever created ⇒ `has()` is always
   * false ⇒ every git op resolves to the LOCAL adapter — byte-identical to pre-Phase-9.
   *
   * PUBLIC so a containerized call site can fork its own host-vs-daemon branch on the SAME discriminator
   * the provider routes on (e.g. ReviewPipelineService's review/ship barrier, open_pr) before deciding
   * whether to use `daemonFor(ctx)` or its unchanged host github flow.
   */
  public isContainerized(ctx: WorkspaceGitCtx): boolean {
    const id = this.sandboxId(ctx);
    return !!id && this.sandboxes.has(id);
  }
}
