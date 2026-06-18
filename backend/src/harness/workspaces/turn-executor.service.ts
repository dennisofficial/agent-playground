import { Injectable, Logger } from '@nestjs/common';
import { EngineRegistry } from '../engines/engine.registry';
import type {
  EWorkerEngineName,
  EngineRunResult,
  RunWorkerArgs,
} from '../engines/worker-engine.port';
import type { Session } from '../sessions/session-registry.port';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import { SandboxRegistry } from './sandbox-registry';

/**
 * The minimal context a turn needs to be ROUTED (local host vs. remote sandbox). Deliberately not the
 * full `Session` — `runReview`/`SelfReviewHandler` don't always have a live session row, but they
 * always know the tenancy + workspace the turn runs in. `session` is carried when present (the daemon
 * keys the in-sandbox worktree off the harness session id, Phase 9), but routing itself only needs
 * `team`/`project`/`workspaceId`.
 */
export interface TurnRoutingCtx {
  team: string;
  project: string;
  /** The workspace the turn runs in — its id is the sandbox uuid for a containerized run, or the
   * local `ws-NNN` for a host run. Optional only for the rare caller with no workspace handle. */
  workspaceId?: string;
  /** The owning session, when the caller has one (session-runner does; review/self-review may not). */
  session?: Session;
}

/**
 * The SINGLE engine-execution seam. Every `engines.get(name).run(args)` call site in the harness goes
 * through `TurnExecutor.run` instead, which forks on `isContainerized(ctx)`:
 *   - LOCAL (the default, and the ONLY path until Phase 9 flips the policy): delegates VERBATIM to
 *     `engines.get(engineName).run(args)` — the exact call the call sites made before, with the exact
 *     same args (`cwd`, `onEvent`, `signal`, …). Byte-identical: runtime behavior is unchanged.
 *   - REMOTE (built but DORMANT this phase): `RemoteTurnDispatcher.dispatch(ctx, engineName, args)`,
 *     which resolves the sandbox + tool sources and dispatches the run to the in-container daemon over
 *     Redis, streaming `onEvent` and bridging `signal`→abort, returning the SAME `EngineRunResult`.
 *
 * The `WorkerEngine` port stays pure (no container fields) — routing lives HERE, not on the port.
 */
@Injectable()
export class TurnExecutor {
  private readonly logger = new Logger(TurnExecutor.name);

  constructor(
    private readonly engines: EngineRegistry,
    private readonly remote: RemoteTurnDispatcher,
    private readonly sandboxes: SandboxRegistry,
  ) {}

  /**
   * Run one engine turn, routed local or remote. `args` is the EXACT `RunWorkerArgs` the call site
   * already built (including `cwd` = the host workspace path); the local branch passes it through
   * untouched, the remote branch strips the non-wire fields and overrides cwd inside the daemon.
   */
  async run(
    ctx: TurnRoutingCtx,
    engineName: EWorkerEngineName,
    args: RunWorkerArgs,
  ): Promise<EngineRunResult> {
    if (this.isContainerized(ctx)) {
      return this.remote.dispatch(ctx, engineName, args);
    }
    // LOCAL — today's path, verbatim. Do NOT touch `args` (cwd/onEvent/signal/model/...): this MUST be
    // byte-identical to the pre-Phase-7 `engines.get(name).run(args)` call.
    return this.engines.get(engineName).run(args);
  }

  /**
   * The routing POLICY — whether this turn runs in an isolated sandbox (Phase 9).
   *
   * THE DISCRIMINATOR: a turn is containerized IFF its `workspaceId` is a LIVE SANDBOX, i.e.
   * `SandboxRegistry.has(workspaceId)`. No engine/project re-check happens here — the create-time policy
   * (in `create_workspace`, gated by `WORKSPACE_SANDBOX_ENABLED` + a registered project + a claude/codex
   * engine) ALREADY decided sandbox-vs-local, and stamped the choice as the session's `workspace_id`
   * (the sandbox uuid for a containerized session, `ws-NNN` for a local one). Routing just reads that
   * decision back off the registry. `WorkspaceGitProvider.isContainerized` uses the SAME predicate, so a
   * session's turns and its git ops always route together.
   *
   * FLAG-OFF SAFETY: with `WORKSPACE_SANDBOX_ENABLED` false, no sandbox is ever created, so `has()` is
   * always false and every turn stays local — byte-identical to pre-Phase-9. (The unit test forces the
   * branch via the test-only subclass override.)
   */
  protected isContainerized(ctx: TurnRoutingCtx): boolean {
    return !!ctx.workspaceId && this.sandboxes.has(ctx.workspaceId);
  }
}
