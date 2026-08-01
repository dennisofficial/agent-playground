import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * A single ordered, idempotent seed step. Replaces `@dltech/nestjs-core`'s `Seeder` type, which is
 * hard-wired to a TypeORM `DataSource` — see `cli/seed-runner.ts` for how these are discovered and run.
 */
export type Seeder = (prisma: PrismaClient) => Promise<void>;
