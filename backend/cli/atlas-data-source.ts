import 'reflect-metadata';

import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { CustomNamingStrategy } from '../src/_lib/database/custom-naming.strategy';
import { ATLAS_ENTITIES } from '../src/atlas/persistence/entities';

/**
 * Standalone DataSource for the TypeORM CLI on Atlas v2's OWN schema — the `atlas_*` entities +
 * `migrations-atlas/`, against the SAME Postgres as v1 (reuses POSTGRES_*). The twin of
 * `cli/data-source.ts` (which owns the v1 shared schema): the two migration histories are kept
 * SEPARATE so each datasource manages only its own tables. Never imported by the app.
 *
 * Run with the `db:atlas:*` scripts (e.g. `pnpm db:atlas:migrate`).
 */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const mode =
    process.env.POSTGRES_SSL_MODE ?? (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export const AtlasDataSource = new DataSource({
  name: 'atlas',
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: ATLAS_ENTITIES,
  migrations: [resolve(__dirname, '../migrations-atlas/*.ts')],
  // Atlas keeps its OWN migrations bookkeeping table so its history never tangles with v1's
  // `migrations` table on the shared database.
  migrationsTableName: 'atlas_migrations',
  synchronize: false,
  logging: ['migration'],
  connectTimeoutMS: 10_000,
  namingStrategy: new CustomNamingStrategy(),
  applicationName: 'atlas-v2 (TypeORM CLI)',
  ssl: resolveSsl(),
});
