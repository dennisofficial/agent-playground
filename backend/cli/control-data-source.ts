import 'reflect-metadata';

import { CONTROL_ENTITIES } from '@workspace/shared/schemas';
import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { CustomNamingStrategy } from '../src/_lib/database/custom-naming.strategy';

/**
 * Standalone DataSource for the CONTROL-PLANE database (the gateway's `tenants` table) — the
 * control twin of data-source.ts, with its own migrations folder. The database name comes from
 * CONTROL_POSTGRES_DB (default `agent_control`), NOT POSTGRES_DB, so the same dev env file drives
 * both the harness DB and the control DB without clashing. Server coordinates are shared.
 */
function resolveSsl(): false | { rejectUnauthorized: boolean } {
  const mode =
    process.env.POSTGRES_SSL_MODE ?? (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export const ControlDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.CONTROL_POSTGRES_DB ?? 'agent_control',
  entities: CONTROL_ENTITIES,
  migrations: [resolve(__dirname, '../migrations-control/*.ts')],
  synchronize: false,
  logging: ['migration'],
  connectTimeoutMS: 10_000,
  namingStrategy: new CustomNamingStrategy(),
  applicationName: 'agent-playground (TypeORM CLI, control)',
  ssl: resolveSsl(),
});
