import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SlackAppModule } from './slack-app.module';
import { SlackDirectoryService } from './slack-directory.service';
import { SlackSocketTransport } from './slack-socket-transport';

/**
 * Boot the harness headless with the Slack surface, on one of two inbound transports:
 *
 * - SLACK_INBOUND=socket (default): own Socket Mode connection — the single-workspace dev shape.
 *   Order matters: the Nest context fully bootstraps FIRST (SurfaceBridge subscribes inbound$
 *   during bootstrap), and only then does the socket open — no inbound event can arrive before
 *   the bridge is listening. The open websocket keeps the process alive.
 * - SLACK_INBOUND=gateway: no Slack connection at all — an HTTP listener on SLACK_INBOUND_PORT
 *   receives gateway-forwarded events/interactivity (tenant-stack shape; outbound still goes
 *   straight to Slack via the workspace's own bot token).
 *
 * Shutdown hooks drain turns and flush write-behinds (ConductorService.onApplicationShutdown).
 */
async function bootstrap() {
  const mode = process.env.SLACK_INBOUND === 'gateway' ? 'gateway' : 'socket';

  // Assert BEFORE the context exists — a half-booted harness is worse than a refused boot.
  const required =
    mode === 'socket'
      ? (['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const)
      : (['SLACK_BOT_TOKEN', 'SLACK_INBOUND_PORT', 'GATEWAY_SHARED_SECRET'] as const);
  for (const key of required) {
    if (!process.env[key]) {
      console.error(
        `${key} is not set — the slack-app needs it in ${mode} mode. ` +
          `Locally: fill it in .env.personal and run pnpm slack:dev.`,
      );
      process.exit(1);
    }
  }

  const logger = setupLogger();
  const log = new Logger('SlackApp');

  if (mode === 'gateway') {
    const app = await NestFactory.create(SlackAppModule, {
      logger,
      abortOnError: false,
    });
    app.enableShutdownHooks();
    // No socket connect in this mode — resolve our own bot identity explicitly (echo-loop guard,
    // self-mention translation, Jarvis's self-join detection all read it).
    const { botName } = await app.get(SlackDirectoryService).resolveSelf();
    const port = Number(process.env.SLACK_INBOUND_PORT);
    await app.listen(port);
    log.log(
      `Gateway-inbound mode as @${botName} — listening for forwarded Slack traffic on :${port}.`,
    );
    return;
  }

  const app = await NestFactory.createApplicationContext(SlackAppModule, {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();
  const transport = app.get(SlackSocketTransport);
  const { botName } = await transport.connect();
  log.log(`Connected to Slack as @${botName} — Socket Mode, no public ingress.`);
}
void bootstrap();
