import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { ATLAS_ENTITIES } from './entities';

/**
 * The named TypeORM connection Atlas v2 owns — distinct from the shared global default connection
 * (`_lib/database/database.module.ts`, which loads `entities: ENTITIES`). Atlas can't piggyback on
 * that one (its entity list is fixed), so it registers its OWN connection here. Repositories bind to
 * it with `@InjectRepository(AtlasX, ATLAS_CONNECTION)` / `TypeOrmModule.forFeature([...], ATLAS_CONNECTION)`.
 */
export const ATLAS_CONNECTION = 'atlas';

/** SSL: off in dev (`disable`), verify-full in prod by default; overridable via POSTGRES_SSL_MODE. */
function resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
  const mode =
    env.get('POSTGRES_SSL_MODE') ??
    (env.get('NODE_ENV') === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

/**
 * Atlas v2's datasource — its OWN named connection ('atlas') loading ONLY the `atlas_*` entities and
 * its own migrations (`migrations-atlas/`), against the SAME Postgres as v1 (reuses the POSTGRES_*
 * env). Schema is managed exclusively through `pnpm db:atlas:migrate`; `synchronize` stays false. The
 * `atlas_*` namespacing keeps these tables from colliding with the live shared schema, so both
 * datasources can target the same database without conflict. @Global so any Atlas submodule can
 * `forFeature([...], ATLAS_CONNECTION)`.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: ATLAS_CONNECTION,
      inject: [EnvService],
      useFactory: (env: EnvService): TypeOrmModuleOptions => ({
        name: ATLAS_CONNECTION,
        type: 'postgres' as const,
        host: env.get('POSTGRES_HOST'),
        port: env.get('POSTGRES_PORT'),
        username: env.get('POSTGRES_USER'),
        password: env.get('POSTGRES_PASSWORD'),
        database: env.get('POSTGRES_DB'),
        entities: ATLAS_ENTITIES,
        synchronize: false,
        namingStrategy: new CustomNamingStrategy(),
        applicationName: 'atlas-v2 (TypeORM)',
        connectTimeoutMS: 10_000,
        ssl: resolveSsl(env),
        extra: { max: env.get('POSTGRES_POOL_MAX') ?? 10 },
      }),
    }),
  ],
})
export class AtlasDatabaseModule {}
