import { Injectable } from '@nestjs/common';

/**
 * The typed contract the WEB SURFACE uses to reach the DRIVER's approval-resolution methods. It is
 * implemented by an adapter the concrete driver registers via {@link DriverApprovalGateway.bind} on
 * bootstrap (forwarding to `ThreadDriver` + `DriverStoreService`).
 *
 * All calls carry plain data:
 *  - `resolveShip` — the "Ship it" click: resume the driver so it re-reaches `finalizeBuild` and ships.
 *  - `retractShip` — the "Back to building" / amend-approve retract: flip `awaiting_ship_review → amending`.
 *    Returns whether it actually acted (a stale/double click returns false).
 *  - `resolveMerge` — the "Merge PR" click: merge through the ONE host merge path. Returns whether the PR
 *    was actually merged (so the synchronous HTTP merge path can surface a non-2xx on a no-op).
 *  - `neutralizeAmendProposal` — neutralize the brain's "Amend build?" proposal card (the Dismiss path, and
 *    the second half of the Approve path).
 */
export interface DriverApprovalHandler {
  resolveShip(jobId: string, ruledBy: string): Promise<void>;
  retractShip(jobId: string, ruledBy: string): Promise<boolean>;
  resolveMerge(jobId: string, ruledBy: string): Promise<boolean>;
  neutralizeAmendProposal(jobId: string, verdictLine: string): Promise<void>;
}

/**
 * The NEUTRAL surface→driver approval seam. Lives in its own leaf module
 * (`DriverApprovalGatewayModule`) that depends on NOTHING, so the surface can inject it without depending
 * on the driver — breaking the module cycle a direct `SurfaceModule → DriverModule` edge would form
 * (`DriverModule` already depends on the surface for `CHAT_SURFACE`).
 *
 * WHY THIS EXISTS: the web surface resolves ship-review / merge / amend-proposal approval clicks by calling
 * driver methods (`ThreadDriver.resolveShipApprovalDurably` / `retractShipDurably` /
 * `resolveMergeApprovalDurably` and `DriverStoreService.neutralizeAmendProposal`). Formerly it reached them
 * via `ModuleRef.get(Service, { strict: false })` behind a lazy dynamic `import()` — the service-locator
 * anti-pattern (untyped, hidden from the constructor, untestable without a real container).
 *
 * This gateway replaces that with an explicit, typed, injected collaborator — mirroring the driver→brain
 * {@link BrainGateway}: the surface depends on the NEUTRAL gateway (no cycle), and the concrete driver plugs
 * itself in at runtime via {@link bind} from `DriverModule.onApplicationBootstrap`. Calls forward straight
 * through — `await`, request/response, and the resolution's own idempotence are all preserved exactly.
 */
@Injectable()
export class DriverApprovalGateway implements DriverApprovalHandler {
  private handler: DriverApprovalHandler | null = null;

  /** Register the concrete driver adapter as the handler (called once from DriverModule.onApplicationBootstrap). */
  bind(handler: DriverApprovalHandler): void {
    this.handler = handler;
  }

  /** The bound handler, or throw a clear error if a surface click raced ahead of the driver's bootstrap
   *  registration (must not happen in practice — approval clicks only fire during live turns, long after
   *  bootstrap). */
  private require(): DriverApprovalHandler {
    if (!this.handler) {
      throw new Error(
        'DriverApprovalGateway used before the driver registered itself (DriverModule.onApplicationBootstrap → bind).',
      );
    }
    return this.handler;
  }

  resolveShip(jobId: string, ruledBy: string): Promise<void> {
    return this.require().resolveShip(jobId, ruledBy);
  }

  retractShip(jobId: string, ruledBy: string): Promise<boolean> {
    return this.require().retractShip(jobId, ruledBy);
  }

  resolveMerge(jobId: string, ruledBy: string): Promise<boolean> {
    return this.require().resolveMerge(jobId, ruledBy);
  }

  neutralizeAmendProposal(jobId: string, verdictLine: string): Promise<void> {
    return this.require().neutralizeAmendProposal(jobId, verdictLine);
  }
}
