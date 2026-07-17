import { EnvService } from '@core/config/env/env.service';
import { Global, Inject, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { CreateModule } from '@workspace/nestjs-core';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.tokens';

@Global()
@CreateModule({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (env: EnvService): Redis => {
        const logger = new Logger('RedisClient');
        const url = env.get('REDIS_URL');

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
      },
      inject: [EnvService],
    },
  ],
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
