import 'reflect-metadata';

import { ENTITIES } from '@workspace/shared/schemas';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { CustomNamingStrategy } from '../src/_lib/database/custom-naming.strategy';

/** Standalone DataSource for the TypeORM CLI (migrations) + the seed runner. Never imported by the app. */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const mode =
    process.env.POSTGRES_SSL_MODE ?? (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: ENTITIES,
  migrations: [resolve(__dirname, '../migrations/*.ts')],
  synchronize: false,
  logging: ['migration'],
  connectTimeoutMS: 10_000,
  namingStrategy: new CustomNamingStrategy(),
  applicationName: 'agent-playground (TypeORM CLI)',
  ssl: resolveSsl(),
});
