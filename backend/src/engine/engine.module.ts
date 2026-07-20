import { EnvService } from '@core/config/env/env.service';
import { RedisModule } from '@lib/redis/redis.module';
import { CreateModule, EnvModule } from '@workspace/nestjs-core';
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
