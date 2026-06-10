import { runSeeds } from '@workspace/nestjs-core';
import { resolve } from 'path';
import { AppDataSource } from './data-source';

/** Runs every idempotent seed in `seeds/` (alphabetical). Dev-only — gated on NODE_ENV. */
async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'development') {
    console.log('seed: NODE_ENV is not "development" — exiting safely');
    process.exit(0);
  }

  await AppDataSource.initialize();
  try {
    await runSeeds(AppDataSource, resolve(__dirname, '../seeds'));
    console.log('seed: all seeds complete');
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
