import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CryptoModule } from '@lib/crypto/crypto.module';
import { K8sModule } from '@lib/k8s/k8s.module';
import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { PrismaModule } from '@lib/prisma/prisma.module';
import { QueueModule } from '@lib/queue/queue.module';
import { RedisModule } from '@lib/redis/redis.module';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@dltech/nestjs-core';
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
import { RepoModule } from './repo/repo.module';
import { SandboxModule } from './sandbox/sandbox.module';
import { SkillsModule } from './skills/skills.module';
import { TurnModule } from './turn/turn.module';
import { WorkspaceProfileModule } from './workspace-profile/workspace-profile.module';

@CreateModule({
  imports: [
    LoggerModule,
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    PrismaModule,
    // Replaces DatabaseModule, RlsModule and RealtimeNestModule together: the policy registry is
    // both the row filter and the live-feed definition, so there is no separate realtime engine to
    // configure and no per-entity guard to build. It resolves its schema against pg_catalog at boot
    // and fails there — on a drifted schema, a model without a primary key, or a misconfigured
    // policy — rather than on the first request.
    PgbaseModule,
    RedisModule,
    CryptoModule,
    K8sModule,
    QueueModule,

    OrgModule,
    AuthModule,
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
