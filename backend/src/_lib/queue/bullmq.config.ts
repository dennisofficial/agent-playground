import { EnvService } from '@core/config/env/env.service';
import { BullRootModuleOptions, SharedBullConfigurationFactory } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { RedisOptions } from 'ioredis';

@Injectable()
export class BullmqConfig implements SharedBullConfigurationFactory {
  constructor(private readonly env: EnvService) {}

  createSharedConfiguration = async (): Promise<BullRootModuleOptions> => {
    return Promise.resolve({
      connection: this.connectionFromUrl(this.env.get('REDIS_URL')),
      prefix: 'bullmq',
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400, count: 50 },
        backoff: { type: 'exponential', delay: 500 },
      },
    });
  };

  private connectionFromUrl(url: string): RedisOptions {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      username: u.username || undefined,
      password: u.password || undefined,
      db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) || 0 : 0,
      tls: u.protocol === 'rediss:' ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  }
}
