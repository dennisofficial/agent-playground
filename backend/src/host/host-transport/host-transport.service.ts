import { Inject, Injectable } from '@nestjs/common';
import type { LiveTurnFrame } from '@workspace/shared';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';
import { jobLiveKey, turnKeys } from '../../_shared/engine/redis-turn-keys';
import type { SteeringFrame, TurnSpec } from '../../_shared/engine/turn-spec';

const EVENTS_BLOCK_MS = 1_000;
const TURN_STALL_MS = 60_000;

/** Live-turn pointer TTL. Must exceed the engine heartbeat (20s) so a healthy-but-quiet turn never expires;
 *  the dispatcher re-sets it on every event, so it only lapses when the host actually stops touching it. */
const LIVE_TTL_S = 90;
/** How often the live SSE polls the pointer while a job is idle, waiting for a turn to start. */
const LIVE_POLL_MS = 500;
/** How long the live SSE blocks per `XREAD` while tailing a turn — bounds detection of turn-end/disconnect. */
const LIVE_BLOCK_MS = 1_000;

/** The live-turn pointer stored at `job:<id>:live` — enough to render `turn_start` and locate the event stream. */
export interface LivePointer {
  turnId: string;
  threadId: string;
  startedAt: number;
}

/** A turn's engine stopped emitting — no event (incl. heartbeat) within the stall window. Thrown by readEvents. */
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

  /** Push a mid-turn steering frame to the running engine; it lands in the live SDK per its priority. */
  async writeInput(turnId: string, frame: SteeringFrame): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).input, '*', 'data', JSON.stringify(frame));
  }

  /**
   * Mark (or refresh) the job's live turn. Called at launch and again on every engine event, so the TTL keeps
   * bumping while the turn is alive and lapses on its own if the host dies mid-turn — the crash-safe presence
   * signal that a stuck working indicator used to need a client-side `needsYou` hack to heal.
   */
  async markTurnLive(jobId: string, pointer: LivePointer): Promise<void> {
    await this.redis.set(jobLiveKey(jobId), JSON.stringify(pointer), 'EX', LIVE_TTL_S);
  }

  /** Clear the job's live turn (turn ended). The TTL is the backstop if this never runs. */
  async clearTurnLive(jobId: string): Promise<void> {
    await this.redis.del(jobLiveKey(jobId));
  }

  /** The job's current live turn, or null if none is running. */
  async readTurnLive(jobId: string): Promise<LivePointer | null> {
    const raw = await this.redis.get(jobLiveKey(jobId));
    return raw ? (JSON.parse(raw) as LivePointer) : null;
  }

  /** Best-effort cleanup of a finished turn's Redis streams (spec/events/input) so they don't accumulate. */
  async disposeTurn(turnId: string): Promise<void> {
    const { spec, events, input } = turnKeys(turnId);
    await this.redis.del(spec, events, input);
  }

  /**
   * The job's live-turn SSE source: one long-lived stream that emits `turn_start` when a turn begins, forwards
   * every engine `event` as it lands (replaying the turn from its first event so a mid-turn subscriber catches
   * up), and emits `turn_end` when the turn produces its `result` or its pointer lapses. Idles between turns —
   * a job can start another turn and this same generator brackets it too. Aborts (client disconnect) tear the
   * duplicated connection down.
   */
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
            // No new events this tick — end the window if the turn is gone or a NEW turn replaced this one.
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
              // The entry id's `<ms>-<seq>` prefix IS the server instant the engine appended this event —
              // stamped once by Redis, so it stays put across a replay to a reconnecting subscriber.
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

  async *readEvents(turnId: string, stallMs: number = TURN_STALL_MS): AsyncGenerator<unknown> {
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
            if (di >= 0) yield JSON.parse(fields[di + 1]);
          }
        }
      }
    } finally {
      conn.disconnect();
    }
  }
}
