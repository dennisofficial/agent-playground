import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { CustomNamingStrategy } from '../../_lib/database/custom-naming.strategy';
import { ENTITIES } from './entities';

export const DB_CONNECTION = 'app';

export const MCP_READER_CONNECTION = 'mcp-reader';
export const MCP_WRITER_CONNECTION = 'mcp-writer';

export function resolveSsl(env: EnvService): false | { rejectUnauthorized: boolean } {
  const mode =
    env.get('POSTGRES_SSL_MODE') ??
    (env.get('NODE_ENV') === 'production' ? 'verify-full' : 'disable');
  if (mode === 'disable') return false;
  return { rejectUnauthorized: mode === 'verify-full' };
}

export function pgConnectionString(env: EnvService): string {
  const user = encodeURIComponent(env.get('POSTGRES_USER'));
  const pass = encodeURIComponent(env.get('POSTGRES_PASSWORD'));
  const host = env.get('POSTGRES_HOST');
  const port = env.get('POSTGRES_PORT') ?? 5432;
  const db = encodeURIComponent(env.get('POSTGRES_DB'));
  return `postgresql://${user}:${pass}@${host}:${port}/${db}`;
}

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
