import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { CryptoModule } from '../_lib/crypto/crypto.module';
import { DatabaseModule } from '../_lib/database/database.module';
import { atlasRealtimeConfig } from '../_lib/realtime/realtime.config';
import { RedisModule } from '../_lib/redis/redis.module';
import { AgentCredentialsModule } from './agent-credentials/agent-credentials.module';
import { AuthModule } from './auth/auth.module';
import { GithubModule } from './github/github.module';
import { JobModule } from './job/job.module';
import { OrgCredentialsModule } from './org-credentials/credentials.module';
import { OrgModule } from './org/org.module';
import { RepoModule } from './repo/repo.module';

@CreateModule({
  imports: [
    LoggerModule,
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    DatabaseModule,
    RedisModule,
    CryptoModule,
    PgRealtimeModule.forRootAsync({ inject: [EnvService], useFactory: atlasRealtimeConfig }),

    OrgModule,
    AuthModule,
    RepoModule,
    JobModule,
    OrgCredentialsModule,
    GithubModule,
    AgentCredentialsModule,
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
