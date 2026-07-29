import { EnvService } from '@core/config/env/env.service';
import { ENodeEnv } from '@core/config/env/validation';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'node:path';
import { CustomNamingStrategy } from './custom-naming.strategy';

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
        // Load every entity from the folder (same glob the CLI data-source uses). This is the
        // single source of truth for what's in the DataSource, so realtime discovery
        // (`buildRealtimeModels` over `dataSource.entityMetadatas`) always sees every
        // `@Realtime` entity — independent of which feature module happens to `forFeature` it.
        entities: [join(__dirname, 'entities', '*.entity.{ts,js}')],
        autoLoadEntities: true,
        synchronize: false,
        namingStrategy: new CustomNamingStrategy(),
        applicationName: 'atlas (TypeORM)',
        connectTimeoutMS: 10_000,
        ssl: DatabaseModule.resolveSsl(env),
        extra: { max: 20, connectionTimeoutMillis: 10_000 },
      }),
    }),
  ],
})
export class DatabaseModule {
  private static resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
    const mode =
      env.get('POSTGRES_SSL_MODE') ??
      (env.get('NODE_ENV') === ENodeEnv.PROD ? 'verify-full' : 'disable');
    if (mode === 'disable') return false;
    return { rejectUnauthorized: mode === 'verify-full' };
  }
}
