// Resolve the `@lib`/`@core`/`@shared` tsconfig path aliases at runtime — the entity files loaded by the
// glob below import through them. Reads TS_NODE_PROJECT (set to tsconfig.cli.json by the db:* scripts).
import 'reflect-metadata';
import 'tsconfig-paths/register';

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
  entities: [resolve(__dirname, '../src/_lib/database/entities/*.entity.{ts,js}')],
  migrations: [resolve(__dirname, '../migrations/*.ts')],
  synchronize: false,
  logging: ['migration'],
  connectTimeoutMS: 10_000,
  namingStrategy: new CustomNamingStrategy(),
  applicationName: 'atlas (TypeORM CLI)',
  ssl: resolveSsl(),
});
