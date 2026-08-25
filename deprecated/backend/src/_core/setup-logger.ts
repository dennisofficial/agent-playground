import { LoggerAdapter } from '@dltech/nestjs-core';

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
