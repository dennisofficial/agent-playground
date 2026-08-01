import { EnvService } from '@core/config/env/env.service';
import { EsmModule } from '@lib/esm/esm.module';
import { RedisModule } from '@lib/redis/redis.module';
import { CreateModule, EnvModule } from '@dltech/nestjs-core';
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
    EsmModule,

    // Modules
    RunnerModule,
  ],
})
export class EngineModule {}
