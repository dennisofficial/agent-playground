import '@core/tracing'; // MUST be first: starts the Langfuse OTEL SDK before any LangChain run

import { EnvService } from '@core/config/env/env.service';
import { ENodeEnv } from '@core/config/env/validation';
import { checkRestartLoop, renderRestartStormWarning } from '@core/dev-restart-guard';
import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { installShutdownGuard } from '@workspace/nestjs-core';
import cookieParser from 'cookie-parser';
import { AppModule } from './app/app.module';

/**
 * The Atlas v2 entrypoint — boots `AppModule` STANDALONE. It imports neither `SlackAppModule` nor
 * `HarnessModule` (both pull in v1 orchestration); v2 stands up on its own composition root with its
 * own named Postgres connection ('atlas', the `app` schema) alongside v1's tables, no drops.
 *
 * W2 flips this from a headless context to a real HTTP app: the per-gateway notification ingress needs
 * an HTTP edge (`POST /ingress/github`, `POST /ingress/webhook`). `rawBody: true` is REQUIRED so the
 * GitHub adapter can HMAC-verify the EXACT request bytes (signature covers raw bytes, never a
 * re-serialized object). The Slack socket-mode inbound is unchanged — the chat bridge connects the
 * surface on boot and feeds typed `Message`s (no HTTP hop). Listens on `HTTP_PORT` (default 4002,
 * kept off v1's 4001).
 *
 * Boot shape mirrors `slack-app/main.ts`: shutdown hooks (drain + flush), and an `unhandledRejection`
 * guard so a stray detached rejection (e.g. a transient Postgres timeout during boot) doesn't kill the
 * process.
 */
async function bootstrap() {
  const logger = setupLogger();
  const log = new Logger('Bootstrap');

  // DEV-ONLY: `nest start --watch` restarts on every recompile; a genuine restart STORM (two `pnpm dev`
  // instances racing a port, or a boot-time crash loop) is otherwise invisible until something breaks —
  // see `dev-restart-guard.ts`. No-op in prod (no watch, no restart cadence to monitor).
  if (process.env.NODE_ENV !== ENodeEnv.PROD) {
    const restartCheck = checkRestartLoop();
    if (restartCheck.looksLikeAStorm) {
      log.warn(renderRestartStormWarning(restartCheck));
    }
  }

  // One HTTP app — hosts the ingress controllers. rawBody for GitHub HMAC signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    rawBody: true,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  // Raise the JSON body limit above Express's ~100 KB default: `provide-file` and the batch `answer-batch`
  // endpoint carry inline file/secret content (`MAX_BATCH_BYTES` = 4 MB; the endpoint enforces the
  // authoritative cap), which the default parser would silently reject before the controller ran. Sized to
  // the batch cap plus overhead; re-registers the rawBody-aware JSON parser, so GitHub HMAC verification is
  // unaffected.
  app.useBodyParser('json', { limit: '8mb' });

  const env = app.get(EnvService);

  // Populates `req.cookies` — the auth guard + `/auth/*` read the access/refresh cookies from it.
  app.use(cookieParser());

  // The browser talks to this app DIRECTLY (no Next.js proxy), so allow the web console's origin with
  // credentials — required for the httpOnly session cookies to ride on cross-origin `/web` + `/auth`
  // requests. `localhost:3000` and `localhost:4002` are the SAME site, so the SameSite=Lax cookies are
  // sent on these cross-origin-but-same-site calls; CORS just needs the explicit origin + credentials.
  app.enableCors({ origin: env.get('FRONTEND_HOST'), credentials: true });

  const port = env.get('HTTP_PORT') ?? 4002;
  await app.listen(port);

  // Guarantee SIGTERM/SIGINT exits within a bounded time (the operator console's SSE streams otherwise pin
  // http.Server.close() forever — wedging every `nest start --watch` restart). The graceful drain still
  // runs via enableShutdownHooks; this just closes the lingering sockets + force-exits as a backstop. Cap:
  // generous in prod (drain grace + buffer, so the graceful blue/green handoff always wins), tight in dev.
  const isProd = env.get('NODE_ENV') === ENodeEnv.PROD;
  const drainGraceMs = 120_000; // SIGTERM drain budget; must stay < the container stop_grace_period.
  installShutdownGuard(app, {
    forceExitAfterMs: isProd ? drainGraceMs + 15_000 : 4_000,
  });

  log.log(
    `Atlas v2 booted on :${port} — own "app" Postgres connection (app schema), ingress ` +
      'POST /ingress/github + /ingress/webhook, Slack chat bridge live. No v1 imports.',
  );
}

// A stray DETACHED rejection must NOT take down the process — log it loudly and keep serving. Genuine
// boot failures are still fatal via bootstrap().catch below. Same pattern as slack-app/daemon main.ts.
process.on('unhandledRejection', (reason) => {
  new Logger('Bootstrap').error(
    `Unhandled promise rejection (kept process alive): ${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

bootstrap().catch((err: unknown) => {
  const log = new Logger('Bootstrap');
  // EADDRINUSE gets its own unmistakable message: in a workflow where multiple agents/terminals may each
  // try to run the dev server, this is the single most common (and most confusing) boot failure — it
  // otherwise reads as a generic stack dump easy to miss in scrollback, and a `nest --watch` supervisor
  // will keep respawning the crashing child on every recompile, producing exactly the kind of restart
  // storm `dev-restart-guard.ts` warns about (two instances racing the same port).
  if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    log.error(
      `Fatal: port already in use — another process (likely a second \`pnpm dev\`) is already bound to ` +
        `it. Stop that instance before starting this one; running two dev servers against the same port ` +
        `causes a restart storm as they race on every file change. (${err.message})`,
    );
    process.exit(1);
    return;
  }
  // Boot itself failed (DB unreachable, a lifecycle hook threw, …) — fail CLEANLY with a readable
  // reason and a non-zero exit instead of an unhandled-rejection stack dump that exits anyway.
  log.error(
    `Fatal: Atlas v2 failed to boot — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
