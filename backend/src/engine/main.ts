import { NestFactory } from '@nestjs/core';
import { EngineTransportService } from './engine-transport/engine-transport.service';
import { EngineModule } from './engine.module';
import { RunnerService } from './runner/runner.service';

async function bootstrap(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('engine: TURN_ID is required (Redis transport)');

  const app = await NestFactory.createApplicationContext(EngineModule, {
    abortOnError: false,
    bufferLogs: true,
  });

  await app.init();

  // Fetch the spec up front, then hand it to the runner.
  const engineTransportService = app.get(EngineTransportService);
  const spec = await engineTransportService.readSpec(turnId);
  const runner = app.get(RunnerService);
  process.on('SIGTERM', () => void runner.interrupt());

  let code = 0;
  try {
    await runner.run(turnId, spec);
  } catch (err) {
    process.stderr.write(
      `[engine] turn failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    code = 1;
  } finally {
    await app.close();
    process.exit(code);
  }
}

void bootstrap();
