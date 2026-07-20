import 'reflect-metadata';

import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { CustomNamingStrategy } from '../src/_lib/database/custom-naming.strategy';

function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const mode =
    process.env.POSTGRES_SSL_MODE ??
    (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export const AppDataSource = new DataSource({
  name: 'app',
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  entities: [resolve(__dirname, '../src/app/**/*.entity.{ts,js}')],
  migrations: [resolve(__dirname, '../migrations/*.ts')],
  // Atlas keeps its OWN migrations bookkeeping table so its history never tangles with v1's
  // `migrations` table on the shared database.
  migrationsTableName: 'migrations',
  synchronize: false,
  logging: ['migration'],
  connectTimeoutMS: 10_000,
  namingStrategy: new CustomNamingStrategy(),
  applicationName: 'atlas (TypeORM CLI)',
  ssl: resolveSsl(),
});
