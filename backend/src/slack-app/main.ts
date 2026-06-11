import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SlackAppModule } from './slack-app.module';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackSocketTransport } from './slack-socket-transport';

/**
 * THE server: boots the harness headless with the Slack surface AND the public Slack ingress
 * (events / interactivity / oauth) on one HTTP listener. Single-process multi-tenant — one process
 * serves every workspace; routing is by team_id inside the router/surface.
 *
 * Two inbound shapes share the same in-process router:
 * - DEV (SLACK_APP_TOKEN set): also open a Socket Mode connection (single-workspace local app).
 * - PROD (no SLACK_APP_TOKEN): the OAuth-distributed Events API app POSTs to the ingress
 *   controllers; resolve our own bot identity explicitly (no socket connect).
 *
 * `rawBody: true` is required for Slack signature verification. Shutdown hooks drain turns and
 * flush write-behinds (ConductorService.onApplicationShutdown).
 */
async function bootstrap() {
  const socketMode = !!process.env.SLACK_APP_TOKEN;

  // Assert BEFORE the context exists — a half-booted harness is worse than a refused boot.
  const required = socketMode
    ? (['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const)
    : (['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'] as const);
  for (const key of required) {
    if (!process.env[key]) {
      console.error(
        `${key} is not set — the server needs it. Locally: fill it in .env.personal and run pnpm slack:dev.`,
      );
      process.exit(1);
    }
  }

  const logger = setupLogger();
  const log = new Logger('SlackApp');

  // One HTTP app — hosts the ingress controllers. rawBody for signature verification.
  const app = await NestFactory.create<NestExpressApplication>(SlackAppModule, {
    logger,
    rawBody: true,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  if (socketMode) {
    // Dev: open the Socket Mode connection (resolves our bot identity on connect).
    const { botName } = await app.get(SlackSocketTransport).connect();
    log.log(`Connected to Slack as @${botName} — Socket Mode (dev).`);
  } else {
    // Prod: no socket — resolve our own bot identity explicitly (echo-loop guard, self-mention
    // translation, Jarvis self-join detection all read it).
    const { botName } = await app.get(SlackDirectoryService).resolveSelf();
    log.log(`Booted as @${botName} — Events API ingress (multi-tenant).`);
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  log.log(`Slack ingress listening on :${port}.`);
}
void bootstrap();
