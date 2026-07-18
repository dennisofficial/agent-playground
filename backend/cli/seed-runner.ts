import { runSeeds } from '@workspace/nestjs-core';
import { resolve } from 'path';
import 'reflect-metadata';
import { AppDataSource } from './data-source';

/**
 * Dev data seeder for the `app` datasource. Mirrors the rs-crm-app pattern: discover + run the idempotent
 * `seeds/*.ts` in order against an initialized DataSource. Guarded to NODE_ENV=development so it can never
 * run against a non-dev database. Invoke with `pnpm db:seed`.
 */
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
