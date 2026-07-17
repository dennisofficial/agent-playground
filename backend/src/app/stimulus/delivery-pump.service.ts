import { Injectable, Logger } from '@nestjs/common';
import type { TurnEnvelope } from '@shared/domain';
import type { TurnChunk } from '@shared/stimulus/chunk-vocabulary';
import { StimulusStoreService } from './stimulus-store.service';

/**
 * The lane-generic inbound delivery core — the ONE path both the brain and (later) a build lane flow
 * through. It owns SELECTION + priority + at-least-once steer/coalesce; everything lane-specific is supplied
 * by the caller via a {@link DeliveryLane} descriptor. This module imports neither the brain nor the driver
 * (only the store) so it stays cycle-free and reusable by any lane.
 */

/**
 * Delivery LEASE window: once the pump takes a pending chat row (steers it / hands it to a fresh turn), it
 * can't be re-selected for this long. Longer than a cold-container provision so a live delivery isn't raced
 * by the sweep; the caller's per-thread serialization is the real serializer, so this is a cross-pass guard.
 */
export const CHAT_DELIVERY_LEASE_MS = 2 * 60 * 1000;

/** The coalescing selection for a fresh turn: the pending rows, one `<user>` chunk each, the id set to stamp
 *  delivered, and whether any row is wake-eligible (only then may a fresh turn START). */
export interface CollectedPending {
  pending: TurnEnvelope[];
  userChunks: TurnChunk[];
  ids: string[];
  wake: boolean;
}

/**
 * How a lane differs, declaratively. The pump owns the generic algorithm; a caller passes this to say WHICH
 * lane, HOW to find its live turn, whether it can steer, HOW to steer/render a message, and WHAT a fresh-turn
 * drain does for that lane.
 *
 *  - brain (`main`): `resolveLiveTurn` = `runningBrainTurn`; `canSteer` = engine `steer` exists;
 *    `drainFreshTurn` coalesces a fresh brain turn.
 *  - build lane (`thread:<id>`, later): `resolveLiveTurn` = `runningSteerableTurn`; `drainFreshTurn` marks
 *    the batch for the next Leg.
 */
export interface DeliveryLane {
  jobId: string;
  orgId: string;
  repoId: string;
  /** `'main'` for the brain, `'thread:<id>'` for a build lane. */
  lane: string;
  resolveLiveTurn(): Promise<{ turn_id: string } | null>;
  canSteer(): boolean;
  steer(turnId: string, id: string, body: string): Promise<void>;
  /** The engine-facing string for a pending row's body (lane-specific framing). */
  renderBody(pending: TurnEnvelope): string;
  drainFreshTurn(collected: CollectedPending): Promise<void>;
}

/** Wake-eligible (d18): `now`/`queue` (absent = `now`) may WAKE a fresh turn; `later` only rides along. */
export function isWakeEligible(s: TurnEnvelope): boolean {
  return (s.priority ?? 'now') !== 'later';
}

/** Steer-eligible (d18): only `now` (absent = `now`) steers mid-turn; `queue`/`later` never interrupt a live turn. */
export function isNowPriority(s: TurnEnvelope): boolean {
  return (s.priority ?? 'now') === 'now';
}

/** Build the `<user name at>` chunk for a human message — attribution reconstructed from the stimulus
 *  author + receipt time at engine-render time (the persisted body stays clean). `role` is provisioned for
 *  later multi-operator persona context; unset for now. */
export function userChunkFor(stimulus: TurnEnvelope): TurnChunk {
  return {
    kind: 'user',
    body: stimulus.body,
    attrs: {
      name: stimulus.author.displayName,
      at: stimulus.receivedAt.toISOString(),
    },
  };
}

/**
 * Coalescing selection for a fresh turn (d18). Fetch the lane's eligible pending chat, then build the
 * chronological `<user>` chunks (one per message), the id set to stamp delivered, and the wake flag (true
 * when at least one pending message is wake-eligible — a lane whose only pending rows are `later` composes
 * them as ride-along but must NOT start a turn on its own). Returns null when nothing is pending.
 */
export async function collectPending(
  store: StimulusStoreService,
  jobId: string,
  lane: string,
  leaseMs: number,
  logger?: Pick<Logger, 'warn'>,
): Promise<CollectedPending | null> {
  const pending = await store.eligiblePendingChat(jobId, leaseMs, lane).catch((err) => {
    logger?.warn(`pump: eligiblePendingChat failed for thread=${jobId}: ${err}`);
    return [] as TurnEnvelope[];
  });
  if (pending.length === 0) return null;
  return {
    pending,
    userChunks: pending.map((p) => userChunkFor(p)),
    ids: pending.map((p) => p.id),
    wake: pending.some(isWakeEligible),
  };
}

/** Steer each pending message into a live turn (lease first; the engine `input_ack` stamps delivered). */
export async function steerPending(
  store: StimulusStoreService,
  lane: Pick<DeliveryLane, 'steer' | 'renderBody'>,
  turnId: string,
  pending: TurnEnvelope[],
  logger?: Pick<Logger, 'warn' | 'debug'>,
): Promise<void> {
  await store
    .leaseChatStimuli(pending.map((p) => p.id))
    .catch((err) => logger?.debug(`pump: leaseChat failed (continuing): ${err}`));
  for (const p of pending) {
    await lane
      .steer(turnId, p.id, lane.renderBody(p))
      .catch((err) =>
        logger?.warn(`pump: steer of turn ${turnId} failed (sweep will re-drive): ${err}`),
      );
  }
}

/**
 * FAST PATH: if a live turn exists and the lane can steer, steer its `now`-priority pending into it and
 * report handled (true). `queue`/`later` stay pending — they drain at turn-end or ride the next turn. A live
 * steerable turn ALWAYS claims the pump (returns true even with nothing to steer) so no fresh turn is
 * double-started on the same session. Returns false when there is no steerable live turn (→ slow path).
 */
export async function trySteerLive(
  store: StimulusStoreService,
  lane: DeliveryLane,
  leaseMs: number,
  logger?: Pick<Logger, 'warn' | 'debug'>,
): Promise<boolean> {
  const live = await lane.resolveLiveTurn().catch(() => null);
  if (!live?.turn_id || !lane.canSteer()) return false;
  const pending = await store.eligiblePendingChat(lane.jobId, leaseMs, lane.lane).catch((err) => {
    logger?.warn(`pump: eligiblePendingChat failed for thread=${lane.jobId}: ${err}`);
    return [] as TurnEnvelope[];
  });
  const nowOnly = pending.filter(isNowPriority);
  if (nowOnly.length) await steerPending(store, lane, live.turn_id, nowOnly, logger);
  return true;
}

/**
 * The lane-generic delivery pump. Injectable so a build-lane caller can DI it; the brain shares the same
 * steps ({@link trySteerLive} / {@link collectPending} / {@link steerPending}) but keeps its own per-thread
 * turn-queue serialization around the slow path. FAST PATH steers a live turn; SLOW PATH collects the batch
 * and hands it to the lane's `drainFreshTurn` (which owns the lane's turn cadence).
 */
@Injectable()
export class DeliveryPump {
  private readonly logger = new Logger(DeliveryPump.name);

  constructor(private readonly store: StimulusStoreService) {}

  async pump(lane: DeliveryLane): Promise<void> {
    if (await trySteerLive(this.store, lane, CHAT_DELIVERY_LEASE_MS, this.logger)) return;

    const collected = await collectPending(
      this.store,
      lane.jobId,
      lane.lane,
      CHAT_DELIVERY_LEASE_MS,
      this.logger,
    );
    // Only WAKE for a wake-eligible (now/queue) message. A lane whose only pending rows are `later` composes
    // them as ride-along into some OTHER turn — it must never start a turn on its own.
    if (!collected || !collected.wake) return;

    // A turn may have appeared since the fast-path check. Steer the `now` messages into it instead of
    // starting a SECOND turn on the same session; queue/later stay pending for the turn-end drain.
    const live = await lane.resolveLiveTurn().catch(() => null);
    if (live?.turn_id && lane.canSteer()) {
      const nowOnly = collected.pending.filter(isNowPriority);
      if (nowOnly.length) await steerPending(this.store, lane, live.turn_id, nowOnly, this.logger);
      return;
    }

    await lane.drainFreshTurn(collected);
  }
}
