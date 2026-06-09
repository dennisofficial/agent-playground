import { setupLogger } from '@core/setup-logger';
import { NestFactory } from '@nestjs/core';
import { TuiModule } from './tui.module';

/**
 * Standalone-context bootstrap (no HTTP server). This is the shape the terminal UI
 * will use: boot the harness module headless, then attach an Ink renderer that
 * subscribes to the conductor's event stream. For now it just proves the context
 * boots and shuts down cleanly.
 */
async function bootstrap() {
  const logger = setupLogger();
  const app = await NestFactory.createApplicationContext(TuiModule, {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  logger.log('TUI placeholder — harness migration pending. Ctrl-C to exit.');
}
void bootstrap();
