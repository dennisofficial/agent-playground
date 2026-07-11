import { Injectable, Logger } from '@nestjs/common';

/**
 * The typed contract the DRIVER uses to reach the BRAIN. It is implemented by the concrete brain
 * (`AgentSessionManager`), which registers itself via {@link BrainGateway.bind} on bootstrap.
 *
 * All four calls carry plain data and return `Promise<void>`:
 *  - `openPrAtShip` — REQUEST/RESPONSE: awaited to completion (the ship step latches the PR only after it).
 *  - the three wakes — fire-and-forget notifications the driver awaits only to log per-attempt failures;
 *    at-least-once retry is driven by the driver's periodic sweeps (the brain stamps a dedup marker on
 *    the wake turn's success tail, so a failed wake stays owed).
 */
export interface BrainGatewayHandler {
  openPrAtShip(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    branch: string;
    defaultBranch: string;
    title: string;
  }): Promise<void>;
  notifyThreadHalted(
    jobId: string,
    threadId: string,
    outcome: 'blocked' | 'incomplete' | 'failed',
    gen: number,
  ): Promise<void>;
  notifyThreadDone(
    jobId: string,
    threadId: string,
    reason: 'final' | 'notable',
  ): Promise<void>;
  wakeForProvisioningFailure(jobId: string, orgId: string, repoId: string): Promise<void>;
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

  notifyThreadHalted(
    jobId: string,
    threadId: string,
    outcome: 'blocked' | 'incomplete' | 'failed',
    gen: number,
  ): Promise<void> {
    return this.require().notifyThreadHalted(jobId, threadId, outcome, gen);
  }

  notifyThreadDone(
    jobId: string,
    threadId: string,
    reason: 'final' | 'notable',
  ): Promise<void> {
    return this.require().notifyThreadDone(jobId, threadId, reason);
  }

  wakeForProvisioningFailure(jobId: string, orgId: string, repoId: string): Promise<void> {
    return this.require().wakeForProvisioningFailure(jobId, orgId, repoId);
  }
}
