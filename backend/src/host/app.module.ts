import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CryptoModule } from '@lib/crypto/crypto.module';
import { DatabaseModule } from '@lib/database/database.module';
import { K8sModule } from '@lib/k8s/k8s.module';
import { QueueModule } from '@lib/queue/queue.module';
import { buildRealtimeModels } from '@lib/realtime/build-realtime-models';
import { RealtimeResourceModule } from '@lib/realtime/realtime-resource.module';
import { atlasRealtimeConfig } from '@lib/realtime/realtime.config';
import { RedisModule } from '@lib/redis/redis.module';
import { atlasRlsOptions } from '@lib/rls/atlas-rls.config';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { getDataSourceToken } from '@nestjs/typeorm';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { RLS_CONTEXT, RlsModule, type RlsContextConfig } from '@workspace/nestjs-rls/nest';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { ClsModule } from 'nestjs-cls';
import type { DataSource } from 'typeorm';
import { AgentCredentialsModule } from './agent-credentials/agent-credentials.module';
import { AuthModule } from './auth/auth.module';
import { GithubModule } from './github/github.module';
import { InboundMessageModule } from './inbound-message/inbound-message.module';
import { JitHostModule } from './jit/jit.module';
import { JobBootstrapModule } from './job-bootstrap/job-bootstrap.module';
import { JobModule } from './job/job.module';
import { McpServersModule } from './mcp-servers/mcp-servers.module';
import { OrgCredentialsModule } from './org-credentials/credentials.module';
import { OrgModule } from './org/org.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RepoModule } from './repo/repo.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { SkillsModule } from './skills/skills.module';
import { TurnModule } from './turn/turn.module';
import { WorkspaceProfileModule } from './workspace-profile/workspace-profile.module';

@CreateModule({
  imports: [
    // ClsMiddleware wraps every request in a CLS context BEFORE guards run, so AuthGuard
    // can publish the user into CLS for the RLS layer to read ambiently.
    ClsModule.forRoot({ middleware: { mount: true }, global: true }),
    LoggerModule,
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    DatabaseModule,
    RedisModule,
    CryptoModule,
    K8sModule,
    RealtimeResourceModule,
    PgRealtimeModule.forRootAsync({
      inject: [EnvService, getDataSourceToken(), RLS_CONTEXT],
      useFactory: (env: EnvService, dataSource: DataSource, ctx: RlsContextConfig) => ({
        ...atlasRealtimeConfig(env),
        models: buildRealtimeModels(dataSource, ctx.resolveClaims),
      }),
    }),
    RlsModule.forRootAsync(atlasRlsOptions),
    QueueModule,

    OrgModule,
    AuthModule,
    RealtimeModule,
    RepoModule,
    JobModule,
    OrgCredentialsModule,
    GithubModule,
    AgentCredentialsModule,
    JitHostModule,
    WorkspaceProfileModule,
    McpServersModule,
    SkillsModule,
    SandboxModule,
    TurnModule,
    InboundMessageModule,
    JobBootstrapModule,
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
