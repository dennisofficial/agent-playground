import { Injectable, Logger } from '@nestjs/common';
import { EngineRegistry } from '../engines/engine.registry';
import type {
  EWorkerEngineName,
  EngineRunResult,
  RunWorkerArgs,
} from '../engines/worker-engine.port';
import type { Session } from '../sessions/session-registry.port';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';

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
   * The routing POLICY — whether this turn runs in an isolated sandbox.
   *
   * PHASE 7: HARD-FALSE. The remote path is built but DORMANT; the live hot path stays 100% local so
   * runtime behavior is unchanged after this phase. The remote branch is exercised ONLY by unit tests
   * (via the test-only override below) until Phase 9 implements + flips the real policy.
   *
   * PHASE 9 (TODO): return `true` when the turn targets a REGISTERED project AND `engineName` !==
   * langgraph (langgraph + chat/conductor stay host-side) — resolved from `ctx.team`/`ctx.project`
   * against `ProjectStore`, gated by the deployment's container config.
   */
  protected isContainerized(_ctx: TurnRoutingCtx): boolean {
    return false;
  }
}
