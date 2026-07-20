import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CryptoModule } from '@lib/crypto/crypto.module';
import { DatabaseModule } from '@lib/database/database.module';
import { atlasRealtimeConfig } from '@lib/realtime/realtime.config';
import { RedisModule } from '@lib/redis/redis.module';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { AgentCredentialsModule } from './agent-credentials/agent-credentials.module';
import { AuthModule } from './auth/auth.module';
import { GithubModule } from './github/github.module';
import { JitHostModule } from './jit/jit-host.module';
import { JobModule } from './job/job.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { OrgCredentialsModule } from './org-credentials/credentials.module';
import { OrgModule } from './org/org.module';
import { RepoModule } from './repo/repo.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { SkillsModule } from './skills/skills.module';
import { WorkspaceProfileModule } from './workspace-profile/workspace-profile.module';

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

    // Workspace-profile cluster (DI scaffold — no runtime behavior yet).
    JitHostModule,
    WorkspaceProfileModule,
    McpServersModule,
    SkillsModule,
    SandboxModule,
    OrchestratorModule,
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
