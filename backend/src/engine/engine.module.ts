import { EnvService } from '@core/config/env/env.service';
import { RedisModule } from '@lib/redis/redis.module';
import { CreateModule, EnvModule } from '@workspace/nestjs-core';
import { engineEnvValidation } from './engine-env.validation';
import { RunnerModule } from './runner/runner.module';

@CreateModule({
  imports: [
    // Core
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: engineEnvValidation,
    }),

    // Libraries
    RedisModule,

    // Modules
    RunnerModule,
  ],
})
export class EngineModule {}
