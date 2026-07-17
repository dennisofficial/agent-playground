import { EnvService } from '@core/config/env/env.service';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IoredisStreamAdapter } from './ioredis-stream.adapter';
import { REDIS_STREAM_PORT } from './redis.port';
import { REDIS_CLIENT, buildRedisClient } from './redis.tokens';

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

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
