import { Inject, Injectable } from '@nestjs/common';
import type { EngineEvent, EngineRunResult, TurnSpec } from '@shared/engine/engine.types';
import { turnKeys } from '@shared/engine/redis-turn-keys';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { REDIS_STREAM_PORT, type RedisStreamPort } from '../../_lib/redis/redis.port';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';
import { ToolBridgeReader } from './bridges/tool-bridge-reader';

const HEARTBEAT_MS = 5_000;
const SPEC_READ_BLOCK_MS = 5_000;
const STEER_BLOCK_MS = 1_000;

export interface EngineErrorFrame {
  t: 'error';
  message: string;
  auth?: boolean;
  sessionId?: string;
  engine?: string;
}

export interface ToolBridge {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface SteerInputReader {
  steerInput: AsyncIterable<{ id?: string; text: string }>;
  stop(): void;
}

@Injectable()
export class TurnTransport {
  private heartbeat?: ReturnType<typeof setInterval>;
  private toolReader?: ToolBridgeReader;
  private toolReaderSub?: Redis;
  private steerConn?: Redis;
  private stopSteer?: () => void;
  private abortUnsub?: () => Promise<void>;

  constructor(
    @Inject(REDIS_STREAM_PORT) private readonly port: RedisStreamPort,
    @Inject(REDIS_CLIENT) private readonly client: Redis,
  ) {}

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

  emitEvent(turnId: string, e: EngineEvent): void {
    void this.port.xadd(turnKeys(turnId).events, { t: 'event', e }).catch(() => undefined);
  }

  async emitFinal(turnId: string, r: EngineRunResult): Promise<void> {
    await this.port.xadd(turnKeys(turnId).events, { t: 'final', r });
  }

  async emitError(turnId: string, frame: EngineErrorFrame): Promise<void> {
    await this.port.xadd(turnKeys(turnId).events, frame).catch(() => undefined);
  }

  startHeartbeat(turnId: string): void {
    const { events } = turnKeys(turnId);
    this.heartbeat = setInterval(() => {
      void this.port.xadd(events, { t: 'heartbeat', ts: Date.now() }).catch(() => undefined);
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  openToolBridge(turnId: string): ToolBridge {
    const { tools, replies } = turnKeys(turnId);
    const reader = new ToolBridgeReader({
      repliesKey: replies,
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

  async onAbort(turnId: string, cb: () => void): Promise<void> {
    this.abortUnsub = await this.port.subscribe(turnKeys(turnId).abort, () => cb());
  }

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

  async cleanup(): Promise<void> {
    this.toolReader?.stopReader();
    this.stopSteer?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.toolReaderSub?.disconnect();
    this.steerConn?.disconnect();
    if (this.abortUnsub) await this.abortUnsub().catch(() => undefined);
  }
}
