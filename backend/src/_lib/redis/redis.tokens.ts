import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

/** DI token for the shared, resilient `ioredis` client (built from REDIS_URL). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Build the shared `ioredis` client RESILIENTLY so the process BOOTS even when Redis is down.
 *
 * Two properties matter for Phase 5:
 *  - `lazyConnect: true` — the socket is NOT opened at construction. NestFactory can therefore wire
 *    the DI graph (and the daemon's `createApplicationContext` / the harness boot) without a live
 *    Redis. The first command (the consumer loop's `ensureGroup`, or a `dispatchRun`) triggers connect.
 *  - `retryStrategy` — never gives up; reconnect backs off and caps. A transient Redis outage causes
 *    commands to reject/queue, NOT the process to crash. Combined with the `'error'` listener below
 *    (which merely logs — an unhandled `error` event on an ioredis client would otherwise throw), the
 *    harness and daemon stay alive across a Redis bounce.
 *
 * Takes a plain `{ url }` (not `EnvService`) so BOTH callers share it: the host `RedisModule` passes
 * `env.get('REDIS_URL')`, while the in-sandbox engine — which has no `EnvService`/Postgres/JWT config —
 * passes `process.env.REDIS_URL`. Absent url → a localhost default so dev/tests construct a
 * (lazily-unconnected) client without configuration.
 */
export function buildRedisClient(opts: { url?: string }): Redis {
  const logger = new Logger('RedisClient');
  const url = opts.url ?? 'redis://127.0.0.1:6379';

  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // don't fail a queued command after N reconnects — Streams are durable
    enableOfflineQueue: true, // buffer commands issued before/while disconnected, flush on reconnect
    retryStrategy: (times: number): number => {
      // Exponential-ish backoff capped at 5s — reconnect forever, never crash.
      const delay = Math.min(times * 200, 5000);
      if (times === 1 || times % 10 === 0) {
        logger.warn(
          `Redis unreachable (attempt ${times}) — retrying in ${delay}ms (${url})`,
        );
      }
      return delay;
    },
  });

  // An ioredis client emits 'error' on every failed (re)connect; with NO listener Node treats it as an
  // unhandled 'error' event and THROWS, killing the process. Logging here is what keeps boot resilient.
  client.on('error', (err: Error) => {
    logger.debug(`Redis client error (resilient, will retry): ${err.message}`);
  });
  client.on('ready', () => logger.log(`Redis connected (${url})`));

  return client;
}
