import { setupLogger } from '@core/setup-logger';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { GatewayModule } from './gateway.module';

/**
 * gateway = the multi-tenant Slack front door — the ONE component that talks to Slack's event
 * pipe. Public HTTP: POST /slack/events + /slack/interactivity (signature-verified, routed by
 * team_id to tenant stacks over the internal network) and GET /slack/oauth (the install redirect
 * that auto-provisions tenants). Owns the control-plane DB (`tenants`); composes NEITHER the
 * harness NOR the tenant schema.
 */
async function bootstrap() {
  // Assert BEFORE the context exists — a gateway that can't verify signatures or exchange the
  // OAuth code must refuse to boot, not limp.
  for (const key of [
    'SLACK_SIGNING_SECRET',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'GATEWAY_SHARED_SECRET',
    'SECRETS_ENCRYPTION_KEY',
  ] as const) {
    if (!process.env[key]) {
      console.error(`${key} is not set — the gateway needs it. Fill it in the gateway env.`);
      process.exit(1);
    }
  }

  // rawBody: signature verification HMACs the exact bytes Slack sent — a re-serialized body
  // would not round-trip.
  const app = await NestFactory.create<NestExpressApplication>(GatewayModule, {
    logger: setupLogger(),
    rawBody: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.GATEWAY_PORT ?? 4100);
  await app.listen(port);
  new Logger('Gateway').log(`Slack gateway listening on :${port}`);
}
void bootstrap();
