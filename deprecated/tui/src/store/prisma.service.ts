import { PrismaBunSqlite } from "prisma-adapter-bun-sqlite";
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ATLAS_PATHS } from "../domain/paths.js";
import { PrismaClient } from "../generated/prisma/client.js";
import { MigratorService } from "./migrator.service.js";
import { BUSY_TIMEOUT_MS } from "./pragmas.js";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly migratorService: MigratorService) {
    super({
      // `wal.busyTimeout` is SQLite's busy_timeout — the per-connection half of multi-instance safety.
      // WAL is set once by the migrator and persists in the file header.
      adapter: new PrismaBunSqlite({
        url: `file:${ATLAS_PATHS.database}`,
        wal: { enabled: true, busyTimeout: BUSY_TIMEOUT_MS },
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    this.migratorService.migrate();
    await this.$connect();
    this.logger.log(`connected to ${ATLAS_PATHS.database}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
