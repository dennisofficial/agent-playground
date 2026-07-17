import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export function buildRedisClient(opts: { url?: string }): Redis {
  const logger = new Logger('RedisClient');
  const url = opts.url ?? 'redis://127.0.0.1:6379';

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // don't fail a queued command after N reconnects — Streams are durable
    enableOfflineQueue: true, // buffer commands issued before/while disconnected, flush on reconnect
    retryStrategy: (times: number): number => {
      const delay = Math.min(times * 200, 5000);
      if (times === 1 || times % 10 === 0) {
        logger.warn(`Redis unreachable (attempt ${times}) — retrying in ${delay}ms (${url})`);
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
