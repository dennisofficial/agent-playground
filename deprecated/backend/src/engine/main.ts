import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EngineTransportService } from './engine-transport/engine-transport.service';
import { EngineModule } from './engine.module';
import { RunnerService } from './runner/runner.service';

const logger = new Logger('EngineMain');

async function bootstrap(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('engine: TURN_ID is required (Redis transport)');

  logger.log(`boot: turn ${turnId} (transport=${process.env.ENGINE_TRANSPORT ?? 'redis'})`);
  // No bufferLogs: buffered logs are dropped unless useLogger() is called, which blinds us to the whole run.
  const app = await NestFactory.createApplicationContext(EngineModule, { abortOnError: false });
  await app.init();

  // Fetch the spec up front, then hand it to the runner.
  const engineTransportService = app.get(EngineTransportService);
  logger.log(`reading spec from Redis…`);
  const spec = await engineTransportService.readSpec(turnId);
  logger.log(`spec read (model=${spec.model ?? 'default'}, cwd=${spec.cwd})`);

  const runner = app.get(RunnerService);
  process.on('SIGTERM', () => void runner.interrupt());

  let code = 0;
  try {
    await runner.run(turnId, spec);
    logger.log(`completed`);
  } catch (err) {
    logger.error(
      `turn ${turnId} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    code = 1;
  } finally {
    await app.close();
    process.exit(code);
  }
}

// Catch failures before/around bootstrap (e.g. a spec that never arrives) so they land in the log
// instead of a silent unhandled rejection.
void bootstrap().catch((err) => {
  logger.error(
    `engine bootstrap failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
