import '@core/tracing'; // MUST be first: starts the Langfuse OTEL SDK before any LangChain run

import { EnvService } from '@core/config/env/env.service';
import { ENodeEnv } from '@core/config/env/validation';
import { checkRestartLoop, renderRestartStormWarning } from '@core/dev-restart-guard';
import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { installShutdownGuard } from '@workspace/nestjs-core';
import cookieParser from 'cookie-parser';
import { AppOldModule } from './app-old.module';

async function bootstrap() {
  const logger = setupLogger();
  const log = new Logger('Bootstrap');

  if (process.env.NODE_ENV !== ENodeEnv.PROD) {
    const restartCheck = checkRestartLoop();
    if (restartCheck.looksLikeAStorm) {
      log.warn(renderRestartStormWarning(restartCheck));
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppOldModule, {
    logger,
    rawBody: true,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  app.useBodyParser('json', { limit: '8mb' });

  const env = app.get(EnvService);

  app.use(cookieParser());

  app.enableCors({ origin: env.get('FRONTEND_HOST'), credentials: true });

  const port = env.get('HTTP_PORT') ?? 4002;
  await app.listen(port);

  const isProd = env.get('NODE_ENV') === ENodeEnv.PROD;
  const drainGraceMs = 120_000; // SIGTERM drain budget; must stay < the container stop_grace_period.
  installShutdownGuard(app, {
    forceExitAfterMs: isProd ? drainGraceMs + 15_000 : 4_000,
  });

  log.log(
    `Atlas v2 booted on :${port} — own "app" Postgres connection (app schema), ingress ` +
      'POST /ingress/github + /ingress/webhook, Slack chat bridge live. No v1 imports.',
  );
}

process.on('unhandledRejection', (reason) => {
  new Logger('Bootstrap').error(
    `Unhandled promise rejection (kept process alive): ${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

bootstrap().catch((err: unknown) => {
  const log = new Logger('Bootstrap');
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    log.error(
      `Fatal: port already in use — another process (likely a second \`pnpm dev\`) is already bound to ` +
        `it. Stop that instance before starting this one; running two dev servers against the same port ` +
        `causes a restart storm as they race on every file change. (${err.message})`,
    );
    process.exit(1);
    return;
  }
  log.error(
    `Fatal: Atlas v2 failed to boot — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
