import { Injectable, Logger } from '@nestjs/common';
import type { ActiveTurnEntity } from '../persistence/entities';

/**
 * The result of asking a kind's owner to reattach one orphaned-but-alive turn.
 *  - `attached`: a recovery was (re-)triggered — a build drive was re-kicked / is already in flight, or the
 *    brain session is being rebuilt. The resumed host relay will advance the heartbeat and pull the turn out
 *    of the stale set once it re-tails the live stream.
 *  - `deferred`: this owner can't recover it right now (job halted/parked/terminal/gone, or the ctx needed to
 *    rebuild the harness is missing). It's left for its existing recovery path (operator resume / boot sweep /
 *    chat pump); the watchdog keeps it alive (never finalizes a turn whose stream is live).
 */
export type ReattachOutcome = 'attached' | 'deferred';

/** Reattach one in-flight turn addressed by its `active_turns` row. Owned by the kind's driver/brain. */
export type TurnReattachHandler = (row: ActiveTurnEntity) => Promise<ReattachOutcome>;

/**
 * The neutral routing table from an `active_turns.kind` to the component that can RE-ATTACH a turn of that
 * kind — the driver owns `step`/`gate`/`review`/`autofix`, the brain owns `brain`/`compaction`. It exists so
 * the leader {@link TurnWatchdogService} (in @Global `SandboxModule`) can trigger a live re-attach without
 * construct-depending on the driver or brain (which construct-depend on this module — a DI cycle). Each owner
 * registers its handler on bootstrap; the watchdog only reads. Kinds with no handler (e.g. `rotation`, which
 * is crash-safe by its own re-nudge) simply have no entry and are left alive by the watchdog's safety-net.
 */
@Injectable()
export class TurnReattachRegistry {
  private readonly logger = new Logger(TurnReattachRegistry.name);
  private readonly handlers = new Map<ActiveTurnEntity['kind'], TurnReattachHandler>();

  /** Bind the reattach handler for a turn kind (idempotent; a re-register replaces the prior binding). */
  register(kind: ActiveTurnEntity['kind'], handler: TurnReattachHandler): void {
    if (this.handlers.has(kind)) {
      this.logger.debug(`re-registering reattach handler for kind=${kind}`);
    }
    this.handlers.set(kind, handler);
  }

  /** The handler for a kind, or undefined when no owner has claimed it. */
  handlerFor(kind: ActiveTurnEntity['kind']): TurnReattachHandler | undefined {
    return this.handlers.get(kind);
  }
}
