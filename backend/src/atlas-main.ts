import '@core/tracing'; // MUST be first: starts the Langfuse OTEL SDK before any LangChain run

import { EnvService } from '@core/config/env/env.service';
import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AtlasModule } from './atlas/atlas.module';

/**
 * The Atlas v2 entrypoint — boots `AtlasModule` STANDALONE. It imports neither `SlackAppModule` nor
 * `HarnessModule` (both pull in v1 orchestration); v2 stands up on its own composition root with its
 * own named Postgres connection ('atlas', the `atlas_*` schema) alongside v1's tables, no drops.
 *
 * W2 flips this from a headless context to a real HTTP app: the per-gateway notification ingress needs
 * an HTTP edge (`POST /ingress/github`, `POST /ingress/webhook`). `rawBody: true` is REQUIRED so the
 * GitHub adapter can HMAC-verify the EXACT request bytes (signature covers raw bytes, never a
 * re-serialized object). The Slack socket-mode inbound is unchanged — the chat bridge connects the
 * surface on boot and feeds `ChatStimulus` (no HTTP hop). Listens on `ATLAS_HTTP_PORT` (default 4002,
 * kept off v1's 4001).
 *
 * Boot shape mirrors `slack-app/main.ts`: shutdown hooks (drain + flush), and an `unhandledRejection`
 * guard so a stray detached rejection (e.g. a transient Postgres timeout during boot) doesn't kill the
 * process.
 */
async function bootstrap() {
  const logger = setupLogger();
  const log = new Logger('AtlasV2');

  // One HTTP app — hosts the ingress controllers. rawBody for GitHub HMAC signature verification.
  const app = await NestFactory.create<NestExpressApplication>(AtlasModule, {
    logger,
    rawBody: true,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const port = app.get(EnvService).get('ATLAS_HTTP_PORT') ?? 4002;
  await app.listen(port);

  log.log(
    `Atlas v2 booted on :${port} — own "atlas" Postgres connection (atlas_* schema), ingress ` +
      'POST /ingress/github + /ingress/webhook, Slack chat bridge live. No v1 imports.',
  );
}

// A stray DETACHED rejection must NOT take down the process — log it loudly and keep serving. Genuine
// boot failures are still fatal via bootstrap().catch below. Same pattern as slack-app/daemon main.ts.
process.on('unhandledRejection', (reason) => {
  new Logger('AtlasV2').error(
    `Unhandled promise rejection (kept process alive): ${
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    }`,
  );
});

bootstrap().catch((err: unknown) => {
  // Boot itself failed (DB unreachable, a lifecycle hook threw, …) — fail CLEANLY with a readable
  // reason and a non-zero exit instead of an unhandled-rejection stack dump that exits anyway.
  new Logger('AtlasV2').error(
    `Fatal: Atlas v2 failed to boot — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  process.exit(1);
});
