import { NestFactory } from '@nestjs/core';
import { EngineModule } from './engine.app-module';
import { TurnRunner } from './turn-runner.service';
import { TurnTransport } from './transport/turn-transport.service';

/**
 * The in-sandbox engine's composition root (ADR-0001). Boots a headless application context for ONE turn,
 * runs it to a `final`/`error` frame, and forces `process.exit` — the SDK/ioredis leave handles open that
 * would otherwise hang this one-shot. `TURN_ID`/`REDIS_URL` arrive as exec env from the host's
 * `RedisEngineRunner`. Exit code is BINARY: 0 on success, 1 on any turn failure (`TurnRunner` already
 * XADDed the terminal `error` frame with the auth/session detail — the host reads that from the frame,
 * not the exit code).
 */
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
    // The turn failure is already reported over Redis (TurnRunner's error frame); the exit code is a
    // plain 0/1 the host runner reads alongside it.
    code = 1;
  } finally {
    await transport.cleanup();
    await app.close();
    process.exit(code);
  }
}

bootstrap().catch((err: unknown) => {
  // Only fires if bootstrap threw BEFORE the turn ran (e.g. missing TURN_ID / context boot) — a running
  // turn reports its own failures over Redis inside `runner.run`.
  process.stderr.write(
    `[engine] fatal boot error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
