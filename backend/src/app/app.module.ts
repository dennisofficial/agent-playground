import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { RedisModule } from '../_lib/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { OrgModule } from './org/org.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RepoModule } from './repo/repo.module';

@CreateModule({
  imports: [
    // Core Modules
    LoggerModule,
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    DatabaseModule,
    RedisModule,
    RealtimeModule,

    // App Modules
    OrgModule,
    AuthModule,
    RepoModule,
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
