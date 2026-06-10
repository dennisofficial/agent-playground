import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ENTITIES } from '@workspace/shared/schemas';
import { CustomNamingStrategy } from './custom-naming.strategy';

/** SSL: off in dev (`disable`), verify-full in prod by default; overridable via POSTGRES_SSL_MODE. */
function resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
  const mode = env.get('POSTGRES_SSL_MODE') ?? (env.get('NODE_ENV') === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

/**
 * Global TypeORM connection. Schema is managed exclusively through the CLI migrations
 * (`pnpm db:migrate`); `synchronize` stays false. Entities come from `@workspace/shared/schemas`.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [EnvService],
      useFactory: (env: EnvService): TypeOrmModuleOptions => ({
        type: 'postgres' as const,
        host: env.get('POSTGRES_HOST'),
        port: env.get('POSTGRES_PORT'),
        username: env.get('POSTGRES_USER'),
        password: env.get('POSTGRES_PASSWORD'),
        database: env.get('POSTGRES_DB'),
        entities: ENTITIES,
        synchronize: false,
        namingStrategy: new CustomNamingStrategy(),
        applicationName: 'agent-playground (TypeORM)',
        connectTimeoutMS: 10_000,
        ssl: resolveSsl(env),
        extra: { max: env.get('POSTGRES_POOL_MAX') ?? 10 },
      }),
    }),
  ],
})
export class DatabaseModule {}
