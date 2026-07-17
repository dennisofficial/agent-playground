import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { ENTITIES } from './entities';

/**
 * The named TypeORM connection Atlas v2 owns — distinct from the shared global default connection
 * (`_lib/database/database.module.ts`, which loads `entities: ENTITIES`). Atlas can't piggyback on
 * that one (its entity list is fixed), so it registers its OWN connection here. Repositories bind to
 * it with `@InjectRepository(Entity, DB_CONNECTION)` / `TypeOrmModule.forFeature([...], DB_CONNECTION)`.
 */
export const DB_CONNECTION = 'app';

/**
 * The two dedicated diagnostics connections the `atlas-prod` MCP uses — NEVER the full-priv `app`
 * connection (d4). `MCP_READER_CONNECTION` is a SELECT-only pool (all reads + the pre-approval preview);
 * `MCP_WRITER_CONNECTION` is a DML-only pool used ONLY to execute an operator-approved recovery statement.
 * Consumers inject via `@InjectDataSource(MCP_READER_CONNECTION)` / `@InjectDataSource(MCP_WRITER_CONNECTION)`.
 */
export const MCP_READER_CONNECTION = 'mcp-reader';
export const MCP_WRITER_CONNECTION = 'mcp-writer';

/** SSL: off in dev (`disable`), verify-full in prod by default; overridable via POSTGRES_SSL_MODE. */
export function resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
  const mode =
    env.get('POSTGRES_SSL_MODE') ??
    (env.get('NODE_ENV') === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

/**
 * A direct (non-pooled) libpq connection string from the same POSTGRES_* env the datasource uses.
 * Shared by the raw `pg.Client` consumers (leader election, realtime engine admin) so the URL shape
 * lives in one place.
 */
export function pgConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const pass = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const host = env.get('POSTGRES_HOST');
  const port = env.get('POSTGRES_PORT') ?? 5432;
  const db = encodeURIComponent(env.get('POSTGRES_DB'));
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

/**
 * Atlas v2's datasource — its OWN named connection ('atlas') loading ONLY the `app` entities and
 * its own migrations (`migrations/`), against the SAME Postgres as v1 (reuses the POSTGRES_*
 * env). Schema is managed exclusively through `pnpm db:migrate`; `synchronize` stays false. The
 * `app` namespacing keeps these tables from colliding with the live shared schema, so both
 * datasources can target the same database without conflict. @Global so any Atlas submodule can
 * `forFeature([...], DB_CONNECTION)`.
 */
/**
 * The dedicated diagnostics pool factory shared by the SELECT-only `mcp_reader` and DML-only `mcp_writer`
 * connections. Both live on the SAME Postgres server/DB as the app (reusing `POSTGRES_HOST/PORT/DB`); only
 * the login role (its GRANTs) differs, supplied via `MCP_{READER,WRITER}_PG_USER/PASSWORD`. Loads the full
 * `ENTITIES` graph so the relocated read handlers can `getRepository(...)`; the GRANT-level restriction is
 * what enforces read-only/DML-only, independent of loaded metadata.
 */
function mcpPoolOptions(
  env: EnvService,
  name: string,
  userKey: 'MCP_READER_PG_USER' | 'MCP_WRITER_PG_USER',
  passwordKey: 'MCP_READER_PG_PASSWORD' | 'MCP_WRITER_PG_PASSWORD',
  maxConnections: number,
): TypeOrmModuleOptions {
  return {
    name,
    type: 'postgres' as const,
    host: env.get('POSTGRES_HOST'),
    port: env.get('POSTGRES_PORT'),
    username: env.get(userKey),
    password: env.get(passwordKey),
    database: env.get('POSTGRES_DB'),
    entities: ENTITIES,
    synchronize: false,
    namingStrategy: new CustomNamingStrategy(),
    applicationName: `atlas (${name})`,
    connectTimeoutMS: 10_000,
    ssl: resolveSsl(env),
    extra: { max: maxConnections },
  };
}

/**
 * The two diagnostics pools are registered ONLY when their credentials are present. In dev and on every
 * non-Atlas deployment the `MCP_{READER,WRITER}_PG_*` vars are unset (fail-closed, per d3), so the pools
 * are absent — nothing tries to eager-connect a role that does not exist, and boot never crashes. The
 * `atlas-prod` tools that would use them are slug-gated off in exactly those deployments, so their
 * `@Optional() @InjectDataSource(...)` simply resolves to `undefined` and is never queried. In an
 * Atlas deployment the creds ARE set, so both pools register and connect as their least-privilege role.
 */
const MCP_POOL_IMPORTS = [
  ...(process.env.MCP_READER_PG_USER
    ? [
        TypeOrmModule.forRootAsync({
          name: MCP_READER_CONNECTION,
          inject: [EnvService],
          useFactory: (env: EnvService): TypeOrmModuleOptions =>
            mcpPoolOptions(
              env,
              MCP_READER_CONNECTION,
              'MCP_READER_PG_USER',
              'MCP_READER_PG_PASSWORD',
              4,
            ),
        }),
      ]
    : []),
  ...(process.env.MCP_WRITER_PG_USER
    ? [
        TypeOrmModule.forRootAsync({
          name: MCP_WRITER_CONNECTION,
          inject: [EnvService],
          useFactory: (env: EnvService): TypeOrmModuleOptions =>
            mcpPoolOptions(
              env,
              MCP_WRITER_CONNECTION,
              'MCP_WRITER_PG_USER',
              'MCP_WRITER_PG_PASSWORD',
              2,
            ),
        }),
      ]
    : []),
];

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: DB_CONNECTION,
      inject: [EnvService],
      useFactory: (env: EnvService): TypeOrmModuleOptions => ({
        name: DB_CONNECTION,
        type: 'postgres' as const,
        host: env.get('POSTGRES_HOST'),
        port: env.get('POSTGRES_PORT'),
        username: env.get('POSTGRES_USER'),
        password: env.get('POSTGRES_PASSWORD'),
        database: env.get('POSTGRES_DB'),
        entities: ENTITIES,
        synchronize: false,
        namingStrategy: new CustomNamingStrategy(),
        applicationName: 'atlas (TypeORM)',
        connectTimeoutMS: 10_000,
        ssl: resolveSsl(env),
        extra: { max: 10 },
      }),
    }),
    ...MCP_POOL_IMPORTS,
  ],
})
export class OrmConnectionModule {}
