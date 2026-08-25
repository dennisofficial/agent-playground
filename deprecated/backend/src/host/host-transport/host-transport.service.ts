import { Inject, Injectable } from '@nestjs/common';
import type { LiveTurnFrame } from '@workspace/shared';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';
import { jobLiveKey, turnKeys } from '../../_shared/engine/redis-turn-keys';
import type { SteeringFrame, TurnSpec } from '../../_shared/engine/turn-spec';

const EVENTS_BLOCK_MS = 1_000;
const TURN_STALL_MS = 60_000;

const LIVE_TTL_S = 90;
const LIVE_POLL_MS = 500;
const LIVE_BLOCK_MS = 1_000;

export interface LivePointer {
  turnId: string;
  threadId: string;
  startedAt: number;
}

export class TurnStalledError extends Error {
  constructor(turnId: string, stallMs: number) {
    super(`turn ${turnId} stalled: no engine event for ${stallMs}ms`);
    this.name = 'TurnStalledError';
  }
}

@Injectable()
export class HostTransportService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async writeSpec(turnId: string, spec: TurnSpec): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).spec, '*', 'data', JSON.stringify(spec));
  }

  async writeInput(turnId: string, frame: SteeringFrame): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).input, '*', 'data', JSON.stringify(frame));
  }

  async markTurnLive(jobId: string, pointer: LivePointer): Promise<void> {
    await this.redis.set(jobLiveKey(jobId), JSON.stringify(pointer), 'EX', LIVE_TTL_S);
  }

  async clearTurnLive(jobId: string): Promise<void> {
    await this.redis.del(jobLiveKey(jobId));
  }

  async readTurnLive(jobId: string): Promise<LivePointer | null> {
    const raw = await this.redis.get(jobLiveKey(jobId));
    return raw ? (JSON.parse(raw) as LivePointer) : null;
  }

  async disposeTurn(turnId: string): Promise<void> {
    const { spec, events, input } = turnKeys(turnId);
    await this.redis.del(spec, events, input);
  }

  async *streamLive(jobId: string, signal: AbortSignal): AsyncGenerator<LiveTurnFrame> {
    const conn = this.redis.duplicate();
    const onAbort = (): void => {
      conn.disconnect();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const live = await this.readTurnLive(jobId);
        if (!live) {
          await new Promise((r) => setTimeout(r, LIVE_POLL_MS));
          continue;
        }
        yield {
          kind: 'turn_start',
          turnId: live.turnId,
          threadId: live.threadId,
          startedAt: live.startedAt,
        };

        const eventsKey = turnKeys(live.turnId).events;
        let lastId = '0'; // replay from the turn's first event so a late subscriber gets the whole turn
        let ended = false;
        while (!signal.aborted && !ended) {
          let res: Array<[string, Array<[string, string[]]>]> | null;
          try {
            res = await conn.xread('BLOCK', LIVE_BLOCK_MS, 'STREAMS', eventsKey, lastId);
          } catch {
            if (signal.aborted) return;
            throw new Error(`host-transport: live read failed on ${eventsKey}`);
          }
          if (!res) {
            const cur = await this.readTurnLive(jobId);
            if (!cur || cur.turnId !== live.turnId) ended = true;
            continue;
          }
          for (const [, entries] of res) {
            for (const [id, fields] of entries) {
              lastId = id;
              const di = fields.indexOf('data');
              if (di < 0) continue;
              const event: unknown = JSON.parse(fields[di + 1]);
              yield {
                kind: 'event',
                turnId: live.turnId,
                event,
                emittedAt: Number.parseInt(id, 10),
              };
              if ((event as { type?: string })?.type === 'result') ended = true;
            }
          }
        }
        yield { kind: 'turn_end', turnId: live.turnId };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      conn.disconnect();
    }
  }

  async *readEvents(
    turnId: string,
    stallMs: number = TURN_STALL_MS,
  ): AsyncGenerator<{ event: unknown; emittedAt: number }> {
    const { events } = turnKeys(turnId);
    const conn = this.redis.duplicate();
    try {
      let lastId = '0';
      let lastEventAt = Date.now();
      while (true) {
        const res: Array<[string, Array<[string, string[]]>]> | null = await conn.xread(
          'BLOCK',
          EVENTS_BLOCK_MS,
          'STREAMS',
          events,
          lastId,
        );
        if (!res) {
          if (Date.now() - lastEventAt > stallMs) throw new TurnStalledError(turnId, stallMs);
          continue;
        }
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id;
            lastEventAt = Date.now();
            const di = fields.indexOf('data');
            if (di >= 0)
              yield { event: JSON.parse(fields[di + 1]), emittedAt: Number.parseInt(id, 10) };
          }
        }
      }
    } finally {
      conn.disconnect();
    }
  }
}
