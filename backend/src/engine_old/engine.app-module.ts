import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { IoredisStreamAdapter } from '../_lib/redis/ioredis-stream.adapter';
import { REDIS_STREAM_PORT } from '../_lib/redis/redis.port';
import { REDIS_CLIENT } from '../_lib/redis/redis.tokens';
import { engineRedisClientProvider } from './engine-redis-client.provider';
import { EngineEventBus } from './events/engine-events';
import { TurnEventForwarder } from './events/turn-event-forwarder';
import { TurnTransport } from './transport/turn-transport.service';
import { TurnRunner } from './turn-runner.service';

@Module({
  imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
  providers: [
    engineRedisClientProvider,
    { provide: REDIS_STREAM_PORT, useClass: IoredisStreamAdapter },
    TurnTransport,
    TurnRunner,
    EngineEventBus,
    TurnEventForwarder,
  ],
  exports: [REDIS_STREAM_PORT, REDIS_CLIENT],
})
export class EngineModule {}
