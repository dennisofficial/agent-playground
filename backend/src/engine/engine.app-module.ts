import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { REDIS_STREAM_PORT } from '../_lib/redis/redis.port';
import { IoredisStreamAdapter } from '../_lib/redis/ioredis-stream.adapter';
import { engineRedisClientProvider } from './engine-redis-client.provider';

/**
 * The engine app's composition root. Deliberately does NOT import the host `RedisModule`/`EnvModule` —
 * those validate Postgres/JWT env that doesn't exist in the sandbox and would fail boot. Instead it binds
 * its own engine-local `REDIS_CLIENT` (built straight from `process.env.REDIS_URL`, no `EnvService`) and
 * reuses the shared `IoredisStreamAdapter` binding for `REDIS_STREAM_PORT`. A later thread wires the actual
 * per-turn Redis Streams lifecycle (spec/events/tools/replies) behind this port; today this module only
 * proves `createApplicationContext(EngineModule)` boots standalone.
 */
@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
  providers: [
    engineRedisClientProvider,
    { provide: REDIS_STREAM_PORT, useClass: IoredisStreamAdapter },
  ],
  exports: [REDIS_STREAM_PORT],
})
export class EngineModule {}
