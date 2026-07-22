import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { Inject, Injectable } from '@nestjs/common';
import { turnKeys } from '@shared/engine/redis-turn-keys';
import type { TurnSpec } from '@shared/engine/turn-spec';
import type { Redis } from 'ioredis';

const SPEC_READ_BLOCK_MS = 5_000;
/** How long an input read blocks per poll before re-checking the abort signal — bounds turn-end shutdown latency. */
const INPUT_BLOCK_MS = 1_000;

@Injectable()
export class EngineTransportService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async readSpec(turnId: string): Promise<TurnSpec> {
    const { spec } = turnKeys(turnId);
    const res = await this.redis.xread(
      'COUNT',
      1,
      'BLOCK',
      SPEC_READ_BLOCK_MS,
      'STREAMS',
      spec,
      '0',
    );

    const fields = res?.[0]?.[1]?.[0]?.[1];
    if (!fields) throw new Error(`engine-transport: no spec for turn ${turnId} on ${spec}`);

    const di = fields.indexOf('data');
    if (di < 0)
      throw new Error(`engine-transport: spec frame on ${spec} is missing its 'data' field`);
    return JSON.parse(fields[di + 1]) as TurnSpec;
  }

  async emitEvent(turnId: string, event: unknown): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).events, '*', 'data', JSON.stringify(event));
  }

  async *readInput(turnId: string, signal: AbortSignal): AsyncGenerator<string> {
    const { input } = turnKeys(turnId);
    const conn = this.redis.duplicate();
    const onAbort = () => conn.disconnect();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      let lastId = '0';
      while (!signal.aborted) {
        let res: Array<[string, Array<[string, string[]]>]> | null;
        try {
          res = await conn.xread('BLOCK', INPUT_BLOCK_MS, 'STREAMS', input, lastId);
        } catch {
          // disconnect() on abort rejects the in-flight read — expected at turn end, not an error.
          if (signal.aborted) return;
          throw new Error(`engine-transport: input read failed on ${input}`);
        }
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id;
            const di = fields.indexOf('data');
            if (di >= 0) yield fields[di + 1];
          }
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      conn.disconnect();
    }
  }
}
