import { NestFactory } from '@nestjs/core';
import { EngineModule } from './engine.app-module';
import { TurnTransport } from './transport/turn-transport.service';
import { TurnRunner } from './turn-runner.service';

async function bootstrap(): Promise<void> {
  const turnId = process.env.TURN_ID;
  if (!turnId) throw new Error('engine: TURN_ID is required (Redis transport)');

  const app = await NestFactory.createApplicationContext(EngineModule, {
    abortOnError: false,
    bufferLogs: true,
  });
  const runner = app.get(TurnRunner);
  const transport = app.get(TurnTransport);

  let code = 0;
  try {
    await runner.run(turnId);
  } catch {
    code = 1;
  } finally {
    await transport.cleanup();
    await app.close();
    process.exit(code);
  }
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(
    `[engine] fatal boot error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
