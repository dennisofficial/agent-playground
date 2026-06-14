import '@core/tracing'; // MUST be first: starts the Langfuse OTEL SDK before any LangChain run

import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SlackAppModule } from './slack-app.module';
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

  // Assert BEFORE the context exists — a half-booted harness is worse than a refused boot. Prod
  // (Events API, OAuth-distributed) carries NO static bot token — per-workspace tokens arrive via
  // installs — so only the signing secret is required to boot; SLACK_CLIENT_ID/SECRET are needed
  // for the install flow itself.
  const required = socketMode
    ? (['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const)
    : (['SLACK_SIGNING_SECRET'] as const);
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
    // Dev: open the Socket Mode connection (one workspace, env token).
    const { botName } = await app.get(SlackSocketTransport).connect();
    log.log(
      `Connected to Slack as @${botName ?? 'unknown'} — Socket Mode (dev).`,
    );
  } else {
    // Prod: no socket. Per-workspace bot identities resolve lazily per team_id (the ears tokens
    // arrive via OAuth installs); nothing to resolve at boot.
    log.log(
      'Booted — Events API ingress (multi-tenant); awaiting workspace events.',
    );
  }

  const port = Number(process.env.PORT ?? 4001);
  await app.listen(port);
  log.log(`Slack ingress listening on :${port}.`);
}
void bootstrap();
