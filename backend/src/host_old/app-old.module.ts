import { EnvService } from '@core/config/env/env.service';
import { envConfigValidation } from '@core/config/env/validation';
import { ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { CreateModule, EnvModule, LoggerModule } from '@dltech/nestjs-core';
import { FeaturesModule } from './features.module';
import { PersistenceModule } from './persistence/persistence.module';
import { ProdDiagnosticsModule } from './prod-mcp/prod-diagnostics.module';

@CreateModule({
  imports: [
    LoggerModule,
    ScheduleModule.forRoot(),
    EnvModule.forRoot({
      envService: EnvService,
      validationSchema: envConfigValidation,
    }),
    PersistenceModule,
    ProdDiagnosticsModule,
    FeaturesModule,
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
export class AppOldModule {}
