import { atlasPolicies } from '@lib/pgbase/policies';
import { ScopedDb } from '@lib/pgbase/scoped-db';
import { Test } from '@nestjs/testing';
import { PgbaseModule as PgbaseCoreModule } from '@dltech/pgbase/nest';
import { AsyncLocalStorageContextStore, type ClaimsBuilder } from '@dltech/pgbase/context';
import { PrismaPg } from '@prisma/adapter-pg';
import type { AtlasClaims } from '../../../_lib/pgbase/atlas-claims';
import pgbaseSchema from '../../../generated/pgbase';
import { PrismaClient } from '../../../generated/prisma/client';

const TEST_PRINCIPAL = 'int-test';

/** {@link AtlasClaims}, but mutable — tests reassign a caller's orgs between assertions. */
export interface MutableClaims {
  userId: string;
  orgIds: string[];
  ownerOrgIds: string[];
}

/**
 * Boots a real (but request-free) pgbase runtime against the test database — the same
 * `ScopedDb` a controller would get, minus the HTTP layer. `run()` stands in for the request
 * middleware: it pushes `claims` onto the same `AsyncLocalStorage` the scoped client reads from,
 * so a service written against `ScopedDb` sees an ordinary caller-scoped request.
 */
export interface ScopedTestContext {
  readonly prisma: PrismaClient;
  readonly scopedDb: ScopedDb;
  readonly claims: MutableClaims;
  run<T>(fn: () => Promise<T>): Promise<T>;
  teardown(): Promise<void>;
}

function connectionString(): string {
  const user = encodeURIComponent(process.env.POSTGRES_USER ?? '');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? '');
  const host = process.env.POSTGRES_HOST;
  const port = process.env.POSTGRES_PORT ?? '5432';
  const database = process.env.POSTGRES_DB;
  return `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=disable`;
}

export async function createScopedTestContext(): Promise<ScopedTestContext> {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: connectionString() }) });
  await prisma.$connect();

  const claims: MutableClaims = { userId: 'u1', orgIds: [], ownerOrgIds: [] };
  // Never actually invoked: `run()` below pushes claims onto the ALS context directly, the same
  // way the request middleware does, bypassing the claims cache/builder entirely.
  const claimsBuilder: ClaimsBuilder<string, AtlasClaims> = {
    key: (principal) => principal,
    build: async () => claims,
    ttlMs: 0,
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      PgbaseCoreModule.forRoot({
        prisma,
        schema: pgbaseSchema,
        policies: atlasPolicies,
        claimsBuilder,
        getPrincipal: () => TEST_PRINCIPAL,
        scopedPrisma: ScopedDb,
      }),
    ],
  }).compile();

  const scopedDb = moduleRef.get(ScopedDb);
  const contextStore = moduleRef.get(AsyncLocalStorageContextStore);

  return {
    prisma,
    scopedDb,
    claims,
    run: (fn) => contextStore.run({ principal: TEST_PRINCIPAL, claims }, fn),
    teardown: async () => {
      await moduleRef.close();
      await prisma.$disconnect();
    },
  };
}
