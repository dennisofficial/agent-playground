import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';
import { turnKeys } from '../../_shared/engine/redis-turn-keys';
import type { TurnSpec } from '../../_shared/engine/turn-spec';

/** How long an events read blocks per poll before looping — bounds shutdown latency. */
const EVENTS_BLOCK_MS = 1_000;

@Injectable()
export class HostTransportService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async writeSpec(turnId: string, spec: TurnSpec): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).spec, '*', 'data', JSON.stringify(spec));
  }

  async *readEvents(turnId: string): AsyncGenerator<unknown> {
    const { events } = turnKeys(turnId);
    const conn = this.redis.duplicate();
    try {
      let lastId = '0';
      while (true) {
        const res: Array<[string, Array<[string, string[]]>]> | null = (await conn.xread('BLOCK', EVENTS_BLOCK_MS, 'STREAMS', events, lastId))
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            lastId = id;
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
