import { NestFactory } from '@nestjs/core';
import { EngineModule } from './engine.module';

async function bootstrap(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('engine: TURN_ID is required (Redis transport)');

  const app = await NestFactory.createApplicationContext(EngineModule, {
    abortOnError: false,
    bufferLogs: true,
  });

  await app.init();
}

void bootstrap();
