// MUST be first: starts the Langfuse OTEL SDK before any LangChain run
import '@core/tracing';

import { EnvService } from '@core/config/env/env.service';
import { ENodeEnv } from '@core/config/env/validation';
import { setupLogger } from '@core/setup-logger';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { installShutdownGuard } from '@workspace/nestjs-core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = setupLogger();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    rawBody: true,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  app.useBodyParser('json', { limit: '8mb' });

  const env = app.get(EnvService);

  app.use(cookieParser());

  app.enableCors({ origin: env.get('FRONTEND_HOST'), credentials: true });

  await app.listen(4000);

  const isProd = env.get('NODE_ENV') === ENodeEnv.PROD;
  const drainGraceMs = 120_000; // SIGTERM drain budget; must stay < the container stop_grace_period.
  installShutdownGuard(app, {
    forceExitAfterMs: isProd ? drainGraceMs + 15_000 : 4_000,
  });
}

void bootstrap();
