import { LoggerAdapter } from '@workspace/nestjs-core';

/**
 * Builds the Nest logger used by every app's bootstrap. Reads raw `process.env`
 * (it runs before the DI container exists, so EnvService isn't available yet).
 */
export const setupLogger = (): LoggerAdapter => {
  const logger = new LoggerAdapter('Bootstrap', { timestamp: false });

  if (process.env.ENABLE_TIMESTAMP === 'true') {
    logger.showTimestamp();
  }
  if (process.env.ENABLE_COLOR === 'true') {
    logger.showColor();
  }

  logger.debug(`Loading ${process.env.APP_ENV ?? 'development'} environment`);

  return logger;
};
