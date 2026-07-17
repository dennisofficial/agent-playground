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

/**
 * The engine app's composition root. Deliberately does NOT import the host `RedisModule`/`EnvModule` —
 * those validate Postgres/JWT env that doesn't exist in the sandbox and would fail boot. Instead it binds
 * its own engine-local `REDIS_CLIENT` (built straight from `process.env.REDIS_URL`, no `EnvService`) and
 * reuses the shared `IoredisStreamAdapter` binding for `REDIS_STREAM_PORT`. `TurnTransport` owns all
 * per-turn Redis I/O behind that port (+ the raw client for its dedicated blocking connections) and
 * `TurnRunner` runs one turn to a terminal frame.
 *
 * `TurnRunner` publishes each engine event on `EngineEventBus` rather than calling `TurnTransport.emitEvent`
 * directly; `TurnEventForwarder` is the bus's sole subscriber and does that forwarding, via the
 * `EventEmitterModule` wired below.
 */
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
