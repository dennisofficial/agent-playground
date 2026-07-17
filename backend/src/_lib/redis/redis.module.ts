import { EnvService } from '@core/config/env/env.service';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IoredisStreamAdapter } from './ioredis-stream.adapter';
import { REDIS_STREAM_PORT } from './redis.port';
import { REDIS_CLIENT, buildRedisClient } from './redis.tokens';

/**
 * The shared, REUSABLE Redis module (net-new infra in Phase 5 — there was no app Redis module).
 *
 * Provides two tokens, exported globally so BOTH the host harness and the in-container daemon import
 * this one module and inject the same things:
 *  - `REDIS_CLIENT` — a single resilient/lazy `ioredis` client (see redis.tokens.ts: lazyConnect +
 *    a never-give-up retryStrategy + an 'error' listener, so the process BOOTS with Redis absent).
 *  - `REDIS_STREAM_PORT` — the narrow transport seam (`RedisStreamPort`) every Phase-5 consumer/
 *    producer depends on, bound to the ioredis adapter in prod and an in-memory fake in tests.
 *
 * `@Global` because the daemon consumer loop, the host `DaemonClient`, and the daemon dispatchers all
 * inject the port and live in different modules — re-importing `RedisModule` everywhere would be noise.
 *
 * The client is `lazyConnect`, so importing this module NEVER blocks or fails boot on a missing Redis.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (env: EnvService): Redis => buildRedisClient({ url: env.get('REDIS_URL') }),
      inject: [EnvService],
    },
    {
      provide: REDIS_STREAM_PORT,
      useClass: IoredisStreamAdapter,
    },
  ],
  exports: [REDIS_CLIENT, REDIS_STREAM_PORT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /** Quit the client cleanly on shutdown — drains in-flight commands, then closes the socket. A
   * `quit()` on a never-connected lazy client is a no-op, so this is safe with Redis absent too. */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
