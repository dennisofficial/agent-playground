import { Injectable, Logger } from '@nestjs/common';
import type { TurnEnvelope } from '../../_shared/domain';
import type { TurnChunk } from '../../_shared/stimulus/chunk-vocabulary';
import { StimulusStoreService } from './stimulus-store.service';

export const CHAT_DELIVERY_LEASE_MS = 2 * 60 * 1000;

export interface CollectedPending {
  pending: TurnEnvelope[];
  userChunks: TurnChunk[];
  ids: string[];
  wake: boolean;
}

export interface DeliveryLane {
  jobId: string;
  orgId: string;
  repoId: string;
  lane: string;
  resolveLiveTurn(): Promise<{ turn_id: string } | null>;
  canSteer(): boolean;
  steer(turnId: string, id: string, body: string): Promise<void>;
  renderBody(pending: TurnEnvelope): string;
  drainFreshTurn(collected: CollectedPending): Promise<void>;
}

export function isWakeEligible(s: TurnEnvelope): boolean {
  return (s.priority ?? 'now') !== 'later';
}

export function isNowPriority(s: TurnEnvelope): boolean {
  return (s.priority ?? 'now') === 'now';
}

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

export async function steerPending(
  store: StimulusStoreService,
  lane: Pick<DeliveryLane, 'steer' | 'renderBody'>,
  turnId: string,
  pending: TurnEnvelope[],
  logger?: Pick<Logger, 'warn' | 'debug'>,
): Promise<void> {
  const won = new Set(
    await store
      .claimChatStimuli(
        pending.map((p) => p.id),
        CHAT_DELIVERY_LEASE_MS,
      )
      .catch((err) => {
        logger?.debug(`pump: claim failed (continuing): ${err}`);
        return [] as string[];
      }),
  );
  for (const p of pending) {
    if (!won.has(p.id)) continue; // another caller owns it — never double-deliver
    await lane
      .steer(turnId, p.id, lane.renderBody(p))
      .catch((err) =>
        logger?.warn(`pump: steer of turn ${turnId} failed (sweep will re-drive): ${err}`),
      );
  }
}

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
    if (!collected || !collected.wake) return;

    const live = await lane.resolveLiveTurn().catch(() => null);
    if (live?.turn_id && lane.canSteer()) {
      const nowOnly = collected.pending.filter(isNowPriority);
      if (nowOnly.length) await steerPending(this.store, lane, live.turn_id, nowOnly, this.logger);
      return;
    }

    await lane.drainFreshTurn(collected);
  }
}
