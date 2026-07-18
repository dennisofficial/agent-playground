import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { DatabaseModule } from '../_lib/database/database.module';
import { atlasRealtimeConfig } from '../_lib/realtime/realtime.config';
import { RedisModule } from '../_lib/redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { CredentialsModule } from './credentials/credentials.module';
import { GithubModule } from './github/github.module';
import { OrgModule } from './org/org.module';
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
    // Realtime engine — aggregates every model registered via PgRealtimeModule.forFeature() in the
    // feature modules below. forRootAsync() must come after them (they're imported first, so their
    // forFeature() calls have already registered by the time this evaluates).
    PgRealtimeModule.forRootAsync({ inject: [EnvService], useFactory: atlasRealtimeConfig }),

    // App Modules
    OrgModule,
    AuthModule,
    RepoModule,
    CredentialsModule,
    GithubModule,
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
