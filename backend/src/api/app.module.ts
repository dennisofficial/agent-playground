import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { CreateModule, EnvModule, LoggerModule } from '@workspace/nestjs-core';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

/**
 * api = the HTTP server. Owns REST controllers (and, later, the Slack webhook
 * receiver + admin API for the web portal). The headless harness/conductor gets
 * wired in during the harness-migration pass.
 */
@CreateModule({
  imports: [
    LoggerModule,
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
  ],
  controllers: [ApiController],
  providers: [ApiService],
})
export class AppModule {}
