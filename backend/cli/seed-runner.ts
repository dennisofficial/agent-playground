// Resolve the `@lib`/`@core`/`@shared` tsconfig path aliases at runtime — the seed files loaded by the
// glob below import through them. Reads TS_NODE_PROJECT (set to tsconfig.cli.json by the db:seed script).
// `PrismaService` (imported by `./prisma-client`) is a decorated Nest provider, so `reflect-metadata`
// has to load before it does.
import 'reflect-metadata';
import 'tsconfig-paths/register';

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { Seeder } from '../seeds/_shared/seeder';
import { createCliPrismaClient } from './prisma-client';

const SEEDS_DIR = resolve(__dirname, '../seeds');

/**
 * Runs every top-level `.ts`/`.js` file in `seeds/`, in filename order. `_shared/`, `_data/`, and
 * `_deferred/` are directories, so the extension filter below skips them. Reimplements
 * `@dltech/nestjs-core`'s `runSeeds`, which is hard-wired to a TypeORM `DataSource` and can't drive a
 * Prisma-backed seed.
 */
async function runSeeds(prisma: PrismaClient): Promise<void> {
  const files = readdirSync(SEEDS_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const mod = (await import(resolve(SEEDS_DIR, file))) as { default: Seeder };
    console.log(`seed: running ${file}`);
    await mod.default(prisma);
    console.log(`seed: ${file} done`);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'development') {
    console.log('seed: NODE_ENV is not "development" — exiting safely');
    process.exit(0);
  }

  const prisma = createCliPrismaClient();
  try {
    await runSeeds(prisma);
    console.log('seed: all seeds complete');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
