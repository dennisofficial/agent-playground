import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { JwtModule } from '@workspace/auth/server';
import { DatabaseModule } from '../_lib/database/database.module';
import { LlmKeysModule } from '../harness/llm-keys/llm-keys.module';
import { MetricsModule } from '../harness/metrics/metrics.module';
import { MemoryAdminModule } from '../harness/memory-admin/memory-admin.module';
import { ProjectsModule } from '../harness/projects/projects.module';
import { TenantsModule } from '../harness/tenants/tenants.module';
import { SlackIdentitiesModule } from '../harness/slack-identities/slack-identities.module';
import { AdminTokenGuard } from './admin/admin-token.guard';
import { InternalMetricsController } from './admin/internal-metrics.controller';
import { LlmKeysController } from './admin/llm-keys.controller';
import { MemoryFactsController } from './admin/memory.controller';
import { ProjectsController } from './admin/projects.controller';
import { SlackIdentitiesController } from './admin/slack-identities.controller';
import { TenantsController } from './admin/tenants.controller';
import { TokensController } from './admin/tokens.controller';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { AuthModule } from './auth/auth.module';

/**
 * api = the HTTP server. Owns REST controllers: today the admin API (project registry + GitHub
 * token store — gated by AdminTokenGuard, disabled until ADMIN_API_TOKEN is set), later the Slack
 * webhook receiver. It composes ONLY the slim ProjectsModule + DatabaseModule — NOT HarnessModule
 * (one process composes the harness at a time; the api runs alongside the TUI sharing Postgres).
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    DatabaseModule,
    JwtModule.forRootAsync({
      isGlobal: true,
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        accessSecret: env.get('JWT_ACCESS_SECRET') ?? 'dev-access-secret',
        refreshSecret: env.get('JWT_REFRESH_SECRET') ?? 'dev-refresh-secret',
        issuer: env.get('BACKEND_HOST'),
      }),
    }),
    ProjectsModule,
    LlmKeysModule,
    MetricsModule,
    SlackIdentitiesModule,
    MemoryAdminModule,
    TenantsModule,
    AuthModule,
  ],
  controllers: [
    ApiController,
    ProjectsController,
    TokensController,
    LlmKeysController,
    InternalMetricsController,
    SlackIdentitiesController,
    MemoryFactsController,
    TenantsController,
  ],
  providers: [ApiService, AdminTokenGuard],
})
export class AppModule {}
