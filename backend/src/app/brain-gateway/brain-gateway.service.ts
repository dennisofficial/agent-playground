import { Injectable, Logger } from '@nestjs/common';
import type { UnblockBlockerInfo } from '@shared/domain/message';

/**
 * The typed contract the DRIVER uses to reach the BRAIN. It is implemented by the concrete brain
 * (`AgentSessionManager`), which registers itself via {@link BrainGateway.bind} on bootstrap.
 *
 * All calls carry plain data and return `Promise<void>`:
 *  - `openPrAtShip` — ENQUEUES the open-PR seed onto the ci lane and returns; the PR is latched by the reconciler.
 *  - `seedPreviewOnPostBuild` — ENQUEUES the "Spin up preview" seed onto the post_build lane and returns.
 *  - `seedPostBuildGate` — ENQUEUES the ship-review-gate initial message onto the post_build lane and returns.
 *  - `recordUnblockNote` — records the JIT "unblocked by X, Y" note while the job is STILL blocked (so the
 *    `isJobBlocked` guard holds it with the rest of the backlog); deduped, fire-and-forget.
 *  - `pumpUnblockedJob` — drains the job's `main` lane AFTER the funnel flips it open, coalescing the whole
 *    held backlog (born-blocked/mid-flight note + operator chat + unblock note) into ONE turn; at-least-once
 *    retry is driven by the JobUnblockSweep + the undelivered-chat sweep.
 */
export interface BrainGatewayHandler {
  openPrAtShip(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    branch: string;
    defaultBranch: string;
    title: string;
    /** The `ci` thread-group thread this open-PR seed is enqueued onto — its OWN fresh session, isolated from the
     *  planning brain's session (d14/d15). Enqueued on the ci lane (serialized behind any live post_build turn
     *  via the per-job `active_turns` guard); the PR is latched by the reconciler once the queued turn opens it. */
    threadId: string;
  }): Promise<void>;
  seedPreviewOnPostBuild(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    previewInstructions: string | null;
  }): Promise<void>;
  /** SEEDS the ship-review-gate initial message onto the job's already-spawned `post_build` thread. Called
   *  once, right after the gate-park DB transition, from `ThreadDriver.parkForShipReview`. */
  seedPostBuildGate(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    threadId: string;
  }): Promise<void>;
  recordUnblockNote(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { blockers: UnblockBlockerInfo[] },
  ): Promise<void>;
  pumpUnblockedJob(jobId: string, orgId: string, repoId: string): Promise<void>;
}

/**
 * The NEUTRAL driver→brain seam. Lives in its own leaf module (`BrainGatewayModule`) that depends on
 * NOTHING, so both the brain and the driver can inject it without either module depending on the other.
 *
 * WHY THIS EXISTS: the brain (`AgentSessionManager`) constructs all three driver services in its
 * constructor (`JobLifecycleService`, `BuildShipService`, `ThreadDriver` via `JOB_DISPATCHER`). A driver
 * service that construct-depends on the brain — e.g. a `useExisting: AgentSessionManager` port — therefore
 * closes a DI CONSTRUCTION cycle with no valid instantiation order (Nest deadlocks on boot). Formerly the
 * driver dodged this by reaching the brain via `ModuleRef.get(AgentSessionManager, { strict: false })` at
 * call time — the service-locator anti-pattern (untyped, hidden from the constructor, untestable without a
 * real container).
 *
 * This gateway replaces that with an explicit, typed, injected collaborator: the driver depends on the
 * NEUTRAL gateway (no cycle), and the concrete brain plugs itself in at runtime via {@link bind} from its
 * `onApplicationBootstrap`. Calls forward straight through — `await`, request/response, and the driver's
 * per-attempt failure logging are all preserved exactly.
 */
@Injectable()
export class BrainGateway implements BrainGatewayHandler {
  private readonly logger = new Logger(BrainGateway.name);
  private handler: BrainGatewayHandler | null = null;

  /** Register the concrete brain as the handler (called once from AgentSessionManager.onApplicationBootstrap). */
  bind(handler: BrainGatewayHandler): void {
    this.handler = handler;
  }

  /** The bound handler, or throw a clear error if a driver call raced ahead of the brain's bootstrap
   *  registration (must not happen in practice — driver→brain calls only fire during live turns, long
   *  after bootstrap). */
  private require(): BrainGatewayHandler {
    if (!this.handler) {
      throw new Error(
        'BrainGateway used before the brain registered itself (AgentSessionManager.onApplicationBootstrap → bind).',
      );
    }
    return this.handler;
  }

  openPrAtShip(input: Parameters<BrainGatewayHandler['openPrAtShip']>[0]): Promise<void> {
    return this.require().openPrAtShip(input);
  }

  seedPreviewOnPostBuild(
    input: Parameters<BrainGatewayHandler['seedPreviewOnPostBuild']>[0],
  ): Promise<void> {
    return this.require().seedPreviewOnPostBuild(input);
  }

  seedPostBuildGate(input: Parameters<BrainGatewayHandler['seedPostBuildGate']>[0]): Promise<void> {
    return this.require().seedPostBuildGate(input);
  }

  recordUnblockNote(
    jobId: string,
    orgId: string,
    repoId: string,
    input: { blockers: UnblockBlockerInfo[] },
  ): Promise<void> {
    return this.require().recordUnblockNote(jobId, orgId, repoId, input);
  }

  pumpUnblockedJob(jobId: string, orgId: string, repoId: string): Promise<void> {
    return this.require().pumpUnblockedJob(jobId, orgId, repoId);
  }
}
