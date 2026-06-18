import { Injectable } from '@nestjs/common';
import { DaemonClient } from './daemon-client';
import { DaemonGitAdapter } from './daemon-git.adapter';
import { LocalWorkspaceAdapter } from './local-workspace.adapter';
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
  ) {}

  /** The port to run `ctx`'s git op against — local host today, in-sandbox daemon once Phase 9 flips on. */
  resolve(ctx: WorkspaceGitCtx): WorkspaceGitPort {
    if (this.isContainerized(ctx)) {
      // The sandbox to dispatch to: the session's/ctx's workspace id (= the sandbox uuid for a
      // containerized run). Required on the remote path — without it there's no container to reach.
      const workspaceId = ctx.session?.workspaceId ?? ctx.workspaceId;
      if (!workspaceId) {
        throw new Error(
          'WorkspaceGitProvider: a containerized git op needs a workspaceId (the sandbox to dispatch to).',
        );
      }
      return new DaemonGitAdapter(this.daemon, workspaceId);
    }
    // LOCAL — today's path. The pass-through adapter delegates verbatim to WorkspaceService.
    return this.local;
  }

  /**
   * The routing POLICY — whether this git op runs inside an isolated sandbox.
   *
   * PHASE 8: HARD-FALSE. The remote path is built but DORMANT; the live hot path stays 100% local so
   * runtime behavior is unchanged after this phase. The remote branch is exercised ONLY by unit tests
   * (via a test-only subclass override) until Phase 9 implements + flips the real policy.
   *
   * PHASE 9 (TODO): return `true` when the op targets a REGISTERED project AND the session's engine !==
   * langgraph — resolved from `ctx.team`/`ctx.project` against `ProjectStore`, the SAME policy as
   * `TurnExecutor.isContainerized` (the two seams must agree so a session's turns and git ops route
   * together).
   */
  protected isContainerized(_ctx: WorkspaceGitCtx): boolean {
    return false;
  }
}
