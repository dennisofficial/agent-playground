import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DaemonModule } from './daemon.module';

/**
 * The DAEMON entrypoint — the in-container app that runs Claude/Codex engine turns inside an isolated
 * sandbox. It has NO inbound HTTP yet (it's Redis-driven, wired in Phase 5), so we boot a headless
 * APPLICATION CONTEXT (`createApplicationContext`) rather than an HTTP server: the DI graph comes up,
 * the engines + tools provider + ESM SDK tokens resolve, and the process stays alive on the event
 * loop awaiting work. (When a `/healthz` is wanted later, swap to `NestFactory.create` + `listen`.)
 *
 * Boot shape mirrors the lean `api/main.ts`: shutdown hooks drain on SIGTERM (the sandbox is stopped
 * with `unless-stopped` restart, so clean shutdown matters), and an `unhandledRejection` guard keeps
 * a stray detached rejection from killing the process — the same pattern as `slack-app/main.ts`.
 */
async function bootstrap() {
  const logger = setupLogger();
  const log = new Logger('Daemon');

  const app = await NestFactory.createApplicationContext(DaemonModule, {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  // No HTTP listener — the daemon is Redis-driven: the consumer loop (Phase 5) gives it work, the
  // readiness service (Phase 10) waits for inner Docker then writes the ready marker, and the shutdown
  // service (Phase 10) reaps process groups + downs inner compose stacks. The context is up here and
  // the engines + tools provider are resolvable; the lifecycle hooks own the rest.
  log.log(
    `Daemon booted — application context ready (engines + tools provider resolved). ` +
      `Workspace root: ${process.env.WORKSPACE_ROOT ?? '/workspace/repo'}. ` +
      `Consuming Redis commands; readiness gated on inner Docker.`,
  );
}

// A stray DETACHED rejection (e.g. a fire-and-forget skill sync) must NOT take down the daemon — log
// it loudly and keep the process alive. Genuine boot failures are still fatal via bootstrap().catch.
process.on('unhandledRejection', (reason) => {
  new Logger('Daemon').error(
    `Unhandled promise rejection (kept process alive): ${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

bootstrap().catch((err: unknown) => {
  // Boot itself failed (a lifecycle hook threw, an ESM SDK token failed to load, …) — fail CLEANLY
  // with a readable reason and a non-zero exit instead of an unhandled-rejection stack dump.
  new Logger('Daemon').error(
    `Fatal: daemon failed to boot — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
