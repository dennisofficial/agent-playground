import type { Provider } from '@nestjs/common';
import { REDIS_CLIENT, buildRedisClient } from '../_lib/redis/redis.tokens';

/**
 * The engine-local `REDIS_CLIENT` binding — sourced straight from `process.env.REDIS_URL`, NOT the host
 * `RedisModule`. The host binds this via `EnvService`, which is backed by `envConfigValidation` requiring
 * Postgres/JWT secrets that don't exist in the sandbox exec env; the engine has no such config, so it
 * reuses the same resilient `buildRedisClient` (lazyConnect + never-give-up retry) with the raw exec-env
 * url instead. The host already sets `REDIS_URL` on the exec env from `SANDBOX_REDIS_URL`.
 */
export const engineRedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => buildRedisClient({ url: process.env.REDIS_URL }),
};
