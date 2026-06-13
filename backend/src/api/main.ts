import '@core/tracing'; // MUST be first: starts the Langfuse OTEL SDK before any LangChain run

import { EnvService } from '@core/config/env/env.service';
import { setupLogger } from '@core/setup-logger';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * api = the HTTP server. Today it's a thin Nest app; it grows into the Slack
 * webhook receiver + the admin API for the web portal, and eventually fronts the
 * headless harness (conductor) once the harness-migration pass lands.
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: setupLogger() });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // The admin web portal lives on a different origin and sends credentialed
  // requests, so CORS must name that exact origin (not '*').
  const env = app.get(EnvService);
  app.enableCors({ origin: env.get('FRONTEND_HOST'), credentials: true });

  app.enableShutdownHooks();

  // Cloud Run injects PORT per service — use it; hardcoded fallback for local dev.
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
