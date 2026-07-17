import { Inject, Injectable } from '@nestjs/common';
import type { EngineEvent, EngineRunResult, TurnSpec } from '@shared/engine/engine.types';
import { turnKeys } from '@shared/engine/redis-turn-keys';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';
import { ToolBridgeReader } from './bridges/tool-bridge-reader';

/** How often the engine appends a `{t:'heartbeat'}` so the host watchdog can tell a live-but-quiet
 *  turn from a dead engine (ported verbatim from `engine-entrypoint.ts`). */
const HEARTBEAT_MS = 5_000;
/** Blocking window for the one-shot spec read. The host XADDs the spec BEFORE the kick, so this
 *  normally returns immediately; blocking a few seconds just tolerates a kick/XADD ordering race. */
const SPEC_READ_BLOCK_MS = 5_000;
/** Blocking window for one iteration of the steer-input tail loop (yields control between polls). */
const STEER_BLOCK_MS = 1_000;

/** The terminal `error` frame the engine appends to `turn:{T}:events` when a turn throws. Built by the
 *  `TurnRunner` catch (verbatim from the entrypoint) — the auth/session/engine fields ride the FRAME,
 *  not the process exit code. */
export interface EngineErrorFrame {
  t: 'error';
  message: string;
  auth?: boolean;
  sessionId?: string;
  engine?: string;
}

/** An open Claude tool bridge: `call` round-trips one host-tool invocation, `close` stops the reader. */
export interface ToolBridge {
  /** XADD a `tool_request` (shared client) and await the correlated `tool_response`/`tool_error`. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** A live steer-input reader: an async-iterable of operator steers plus a cooperative `stop`. */
export interface SteerInputReader {
  steerInput: AsyncIterable<{ id?: string; text: string }>;
  stop(): void;
}

/**
 * The ONE place the engine speaks Redis. Every per-turn stream I/O the old `runOverRedis` did inline
 * lives here as a method, keyed via `turnKeys(turnId)` — so `TurnRunner` orchestrates a turn with no
 * raw Redis calls of its own. No behavior change: same frames, same ordering, same at-least-once.
 *
 * CONNECTION MODEL (load-bearing — a blocking/subscribed connection can't serve concurrent commands):
 *  - the injected {@link RedisStreamPort} (the shared main client) serves every non-blocking op —
 *    spec read, heartbeat, event/final/error XADDs, and the tool-bridge `tool_request` XADD;
 *  - the injected raw {@link REDIS_CLIENT} supplies a DEDICATED duplicated connection for each op that
 *    must block: {@link openToolBridge}'s replies reader (`client.duplicate()` via `ToolBridgeReader`)
 *    and {@link readSteerInput}'s blocking input tail (`client.duplicate()`);
 *  - {@link onAbort} rides the port's `subscribe`, which already duplicates the connection internally.
 * These three never share the main client, so a long block never delays a heartbeat/event XADD.
 */
@Injectable()
export class TurnTransport {
  private heartbeat?: ReturnType<typeof setInterval>;
  private toolReader?: ToolBridgeReader;
  /** The tool-bridge replies reader's CURRENT connection (swapped by `makeSub` on a stall-reset). */
  private toolReaderSub?: Redis;
  private steerConn?: Redis;
  private stopSteer?: () => void;
  private abortUnsub?: () => Promise<void>;

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly port: RedisStreamPort,
    @Inject(REDIS_CLIENT) private readonly client: Redis,
  ) {}

  /** Read the single-entry spec stream the host XADDed before the kick. */
  async readSpec(turnId: string): Promise<TurnSpec> {
    const { spec } = turnKeys(turnId);
    const entries = await this.port.xread({
      stream: spec,
      lastId: '0',
      count: 1,
      blockMs: SPEC_READ_BLOCK_MS,
    });
    const frame = entries[0]?.data as TurnSpec | undefined;
    if (!frame) throw new Error(`turn-transport: no spec for turn ${turnId}`);
    return frame;
  }

  /** Append one progress event. Fire-and-forget (best-effort) — mirrors the entrypoint's `onEvent`. */
  emitEvent(turnId: string, e: EngineEvent): void {
    void this.port.xadd(turnKeys(turnId).events, { t: 'event', e }).catch(() => undefined);
  }

  /** Append the single terminal `final` frame (awaited — the host tails this to end the turn). */
  async emitFinal(turnId: string, r: EngineRunResult): Promise<void> {
    await this.port.xadd(turnKeys(turnId).events, { t: 'final', r });
  }

  /** Append the terminal `error` frame (best-effort — a failed write must not mask the original error). */
  async emitError(turnId: string, frame: EngineErrorFrame): Promise<void> {
    await this.port.xadd(turnKeys(turnId).events, frame).catch(() => undefined);
  }

  /** Start the periodic heartbeat; `unref`'d so it never holds the one-shot process open past `final`. */
  startHeartbeat(turnId: string): void {
    const { events } = turnKeys(turnId);
    this.heartbeat = setInterval(() => {
      void this.port.xadd(events, { t: 'heartbeat', ts: Date.now() }).catch(() => undefined);
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  /**
   * Open the Claude tool bridge: a `ToolBridgeReader` on its OWN duplicated connection tails
   * `turn:{T}:replies`, while each `call` XADDs a `tool_request` on the shared port and awaits the
   * correlated reply by id.
   */
  openToolBridge(turnId: string): ToolBridge {
    const { tools, replies } = turnKeys(turnId);
    const reader = new ToolBridgeReader({
      repliesKey: replies,
      // Own blocking connection; `makeSub` reassigns `toolReaderSub` so cleanup disconnects whichever
      // connection is CURRENT (the reader swaps it internally on a stall-reset).
      makeSub: () => {
        this.toolReaderSub = this.client.duplicate();
        return this.toolReaderSub;
      },
      log: (m) => process.stderr.write(`[turn-transport] ${m}\n`),
    });
    reader.start();
    this.toolReader = reader;

    return {
      call: async (name, args) => {
        const id = randomUUID();
        const resultPromise = reader.register(id);
        try {
          await this.port.xadd(tools, { t: 'tool_request', id, name, args });
        } catch (err) {
          reader.cancel(id);
          throw err;
        }
        return resultPromise;
      },
      close: () => reader.stopReader(),
    };
  }

  /**
   * Subscribe cooperative abort on `turn:{T}:abort`. The port's `subscribe` duplicates the connection
   * internally (a subscribed connection can't issue normal commands), so this needs no raw client.
   */
  async onAbort(turnId: string, cb: () => void): Promise<void> {
    this.abortUnsub = await this.port.subscribe(turnKeys(turnId).abort, () => cb());
  }

  /**
   * Tail mid-turn steers off `turn:{T}:input` on its OWN duplicated connection (a blocking XREAD loop).
   * `'0-0'` reads every steer from the start of THIS turn's fresh input stream; `stop` unwinds the loop.
   */
  readSteerInput(turnId: string): SteerInputReader {
    const { input } = turnKeys(turnId);
    const conn = this.client.duplicate();
    this.steerConn = conn;
    let stopped = false;
    this.stopSteer = () => {
      stopped = true;
    };
    const steerInput: AsyncIterable<{ id?: string; text: string }> = {
      async *[Symbol.asyncIterator]() {
        let lastId = '0-0';
        while (!stopped) {
          const r = (await conn.xread('BLOCK', STEER_BLOCK_MS, 'STREAMS', input, lastId)) as Array<
            [string, Array<[string, string[]]>]
          > | null;
          if (!r) continue;
          for (const [, entries] of r) {
            for (const [eid, f] of entries) {
              lastId = eid;
              const di = f.indexOf('data');
              if (di < 0) continue;
              const frame = JSON.parse(f[di + 1]) as {
                id?: string;
                text?: string;
              };
              if (typeof frame.text === 'string' && frame.text.length > 0)
                yield {
                  ...(typeof frame.id === 'string' ? { id: frame.id } : {}),
                  text: frame.text,
                };
            }
          }
        }
      },
    };
    return { steerInput, stop: () => this.stopSteer?.() };
  }

  /**
   * Stop readers + disconnect the dedicated connections. NEVER deletes the turn's streams — stream
   * deletion is HOST-owned (the host `del`s spec/events/tools/replies after it has consumed the terminal
   * frame). Deleting here would race the host tail and could destroy the `final`/`error` frame.
   */
  async cleanup(): Promise<void> {
    this.toolReader?.stopReader();
    this.stopSteer?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.toolReaderSub?.disconnect();
    this.steerConn?.disconnect();
    if (this.abortUnsub) await this.abortUnsub().catch(() => undefined);
  }
}
