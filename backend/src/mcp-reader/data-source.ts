import { DataSource } from 'typeorm';
import { CustomNamingStrategy } from '../_lib/database/custom-naming.strategy';
import { ENTITIES } from '../app/persistence/entities/index';
import type { McpReaderEnv } from './env';

/**
 * Standalone TypeORM DataSource for the mcp-reader — the twin of `cli/data-source.ts` but pointed at a
 * SELECT-only Postgres role (provisioned by infra, never migrated from here). Loads the FULL entity graph
 * (not a subset) because sibling `@ManyToOne` relations resolve against each other at `initialize()` time.
 * All Atlas v2 tables live in the default `public` schema — no `schema` option to set.
 */
export function buildDataSource(env: McpReaderEnv): DataSource {
  return new DataSource({
    name: 'mcp-reader',
    type: 'postgres',
    host: env.pg.host,
    port: env.pg.port,
    username: env.pg.user,
    password: env.pg.password,
    database: env.pg.database,
    entities: ENTITIES,
    synchronize: false,
    namingStrategy: new CustomNamingStrategy(),
    applicationName: 'atlas (mcp-reader)',
    connectTimeoutMS: 10_000,
    extra: { max: 5 },
    ssl: env.pg.ssl === 'verify-full' ? { rejectUnauthorized: true } : false,
  });
}

export async function initDataSource(env: McpReaderEnv): Promise<DataSource> {
  const ds = buildDataSource(env);
  await ds.initialize();
  return ds;
}
