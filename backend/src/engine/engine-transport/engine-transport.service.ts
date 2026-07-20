import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { turnKeys } from '@shared/engine/redis-turn-keys';
import type { TurnSpec } from '@shared/engine/turn-spec';

const SPEC_READ_BLOCK_MS = 5_000;

@Injectable()
export class EngineTransportService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async readSpec(turnId: string): Promise<TurnSpec> {
    const { spec } = turnKeys(turnId);
    const res = (await this.redis.xread(
      'COUNT',
      1,
      'BLOCK',
      SPEC_READ_BLOCK_MS,
      'STREAMS',
      spec,
      '0',
    )) as Array<[string, Array<[string, string[]]>]> | null;

    const fields = res?.[0]?.[1]?.[0]?.[1];
    if (!fields) throw new Error(`engine-transport: no spec for turn ${turnId} on ${spec}`);

    const di = fields.indexOf('data');
    if (di < 0) throw new Error(`engine-transport: spec frame on ${spec} is missing its 'data' field`);
    return JSON.parse(fields[di + 1]) as TurnSpec;
  }

  async emitEvent(turnId: string, event: unknown): Promise<void> {
    await this.redis.xadd(turnKeys(turnId).events, '*', 'data', JSON.stringify(event));
  }
}
