import type { Provider } from '@nestjs/common';
import { REDIS_CLIENT, buildRedisClient } from '../_lib/redis/redis.tokens';

export const engineRedisClientProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: () => buildRedisClient({ url: process.env.REDIS_URL }),
};
