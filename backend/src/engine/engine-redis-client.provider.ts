import { Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../_lib/redis/redis.tokens';

/**
 * Build the engine's `ioredis` client straight from `process.env.REDIS_URL` — NOT `buildRedisClient`
 * (`_lib/redis/redis.tokens.ts`), which requires the host's `EnvService` (Postgres/JWT config validation
 * that doesn't exist in the sandbox). The fallback `redis://redis:6379` matches the in-sandbox-reachable
 * default the old `engine-entrypoint.ts`'s `runOverRedis` used.
 *
 * Mirrors `buildRedisClient`'s resilience knobs: `lazyConnect` so DI wiring never blocks on a live Redis,
 * an unbounded capped `retryStrategy` so a Redis bounce never crashes the process, and an `'error'`
 * listener that only logs — an unhandled ioredis `'error'` event otherwise throws.
 */
export function buildEngineRedisClient(): Redis {
  const logger = new Logger('EngineRedisClient');
  const url = process.env.REDIS_URL ?? 'redis://redis:6379';

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    retryStrategy: (times: number): number => {
      const delay = Math.min(times * 200, 5000);
      if (times === 1 || times % 10 === 0) {
        logger.warn(
          `Redis unreachable (attempt ${times}) — retrying in ${delay}ms (${url})`,
        );
      }
      return delay;
    },
  });

  client.on('error', (err: Error) => {
    logger.debug(`Redis client error (resilient, will retry): ${err.message}`);
  });
  client.on('ready', () => logger.log(`Redis connected (${url})`));

  return client;
}

/** The engine-local `REDIS_CLIENT` binding — no `EnvService`, sourced from raw exec env. */
export const engineRedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => buildEngineRedisClient(),
};
