import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CONTROL_ENTITIES } from '@workspace/shared/schemas';
import { CustomNamingStrategy } from '../_lib/database/custom-naming.strategy';

/** SSL: off in dev (`disable`), verify-full in prod by default; overridable via POSTGRES_SSL_MODE. */
function resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
  const mode =
    env.get('POSTGRES_SSL_MODE') ??
    (env.get('NODE_ENV') === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

/**
 * The CONTROL-PLANE TypeORM connection — the gateway twin of DatabaseModule, pointed at
 * `agent_control` (CONTROL_POSTGRES_DB) with CONTROL_ENTITIES only. Server coordinates are
 * shared with POSTGRES_*; the database name is deliberately its own knob so the same dev env
 * drives the harness DB and the control DB side by side. Schema via `pnpm db:control:migrate`.
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
        database: env.get('CONTROL_POSTGRES_DB') ?? 'agent_control',
        entities: CONTROL_ENTITIES,
        synchronize: false,
        namingStrategy: new CustomNamingStrategy(),
        applicationName: 'agent-playground (gateway)',
        connectTimeoutMS: 10_000,
        ssl: resolveSsl(env),
        extra: { max: env.get('POSTGRES_POOL_MAX') ?? 10 },
      }),
    }),
  ],
})
export class GatewayDatabaseModule {}
