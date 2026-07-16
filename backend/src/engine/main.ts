import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { EngineModule } from './engine.app-module';

/**
 * The in-sandbox engine's composition root. Boots a headless application context (no HTTP listener) for
 * one turn and exits — the per-turn "serverless" model (ADR-0001). `TURN_ID`/`REDIS_URL` arrive as exec
 * env from the host's `RedisEngineRunner` (see `atlas-engine-turn`). Turn execution over Redis Streams is
 * wired in a later thread; today this proves the app boots standalone with only the sandbox's env.
 */
async function bootstrap(): Promise<void> {
  const log = new Logger('EngineBootstrap');
  const turnId = process.env.TURN_ID;
  const app = await NestFactory.createApplicationContext(EngineModule, {
    abortOnError: false,
  });
  log.log(`engine app context booted (turnId=${turnId ?? 'unset'})`);
  await app.close();
  process.exit(0);
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(
    `[engine] fatal boot error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
