import { PrismaPg } from '@prisma/adapter-pg';
import type { EnvService } from '../src/_core/config/env/env.service';
import { PrismaService } from '../src/_lib/prisma/prisma.service';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Standalone Prisma client for CLI scripts (seed runner, etc.). There's no Nest app context here to
 * inject a real `EnvService` from, so this shims `.get()` over `process.env` — the same trick
 * `003-dev-credentials` already uses for `SecretCipherService` — and reuses
 * `PrismaService.connectionString` so the CLI can never compose a different connection string than the
 * running app does. Never introduces a `DATABASE_URL`.
 */
export function createCliPrismaClient(): PrismaClient {
  const envShim = { get: (key: string) => process.env[key] } as unknown as EnvService;
  const connectionString = PrismaService.connectionString(envShim);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
