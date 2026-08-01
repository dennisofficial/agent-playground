import { EnvService } from '@core/config/env/env.service';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The unscoped Prisma client.
 *
 * Inject this for work with no caller to scope to — queue workers, the WAL leader's own bookkeeping,
 * seeds, backfills. Anything serving a request should inject `ScopedDb` instead, which applies the
 * caller's RLS predicate and has no bypass.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(envService: EnvService) {
    super({ adapter: new PrismaPg({ connectionString: PrismaService.connectionString(envService) }) });
  }

  /**
   * Built from the same discrete POSTGRES_* vars the app has always used, mirroring
   * prisma.config.ts so the CLI and the runtime can never point at different databases.
   */
  static connectionString(envService: EnvService): string {
    const user = encodeURIComponent(envService.get('POSTGRES_USER'));
    const password = encodeURIComponent(envService.get('POSTGRES_PASSWORD'));
    const host = envService.get('POSTGRES_HOST');
    const port = envService.get('POSTGRES_PORT');
    const database = envService.get('POSTGRES_DB');
    const sslMode = envService.get('POSTGRES_SSL_MODE') ?? 'disable';
    return `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=${sslMode}`;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
