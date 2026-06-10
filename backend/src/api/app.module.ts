import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { DatabaseModule } from '../_lib/database/database.module';
import { ProjectsModule } from '../harness/projects/projects.module';
import { AdminTokenGuard } from './admin/admin-token.guard';
import { ProjectsController } from './admin/projects.controller';
import { TokensController } from './admin/tokens.controller';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

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
    ProjectsModule,
  ],
  controllers: [ApiController, ProjectsController, TokensController],
  providers: [ApiService, AdminTokenGuard],
})
export class AppModule {}
