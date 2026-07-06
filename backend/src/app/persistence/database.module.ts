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
  ],
})
export class OrmConnectionModule {}
