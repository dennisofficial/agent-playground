import { setupLogger } from '@core/setup-logger';
import { CHAT_SURFACE } from '@harness/surface/chat-surface.port';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { SlackChatSurface } from './slack-chat-surface';
import { SlackAppModule } from './slack-app.module';

/**
 * Boot the harness headless with the Slack surface. Order matters: the Nest context fully
 * bootstraps FIRST (SurfaceBridge subscribes inbound$ during bootstrap), and only then does the
 * Socket Mode connection open — no inbound event can arrive before the bridge is listening. The
 * open websocket keeps the process alive; shutdown hooks drain turns and flush write-behinds
 * (ConductorService.onApplicationShutdown) on SIGTERM/SIGINT.
 */
async function bootstrap() {
  // Assert BEFORE the context exists — SocketModeClient throws an opaque error on a missing app
  // token, and a half-booted harness is worse than a refused boot.
  for (const key of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const) {
    if (!process.env[key]) {
      console.error(
        `${key} is not set — the slack-app needs both SLACK_BOT_TOKEN (xoxb-…) and ` +
          `SLACK_APP_TOKEN (xapp-…). Locally: fill them in .env.personal and run pnpm slack:dev.`,
      );
      process.exit(1);
    }
  }

  const logger = setupLogger();
  const app = await NestFactory.createApplicationContext(SlackAppModule, {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const surface = app.get<SlackChatSurface>(CHAT_SURFACE);
  const { botName } = await surface.connect();
  new Logger('SlackApp').log(
    `Connected to Slack as @${botName} — Socket Mode, no public ingress.`,
  );
}
void bootstrap();
