import { RedisModule } from '@lib/redis/redis.module';
import { CreateModule } from '@workspace/nestjs-core';
import { RunnerModule } from './runner/runner.module';

@CreateModule({
  imports: [
    // Libraries
    RedisModule,

    // Modules
    RunnerModule,
  ],
})
export class EngineModule {}
