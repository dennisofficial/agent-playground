import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  TranscriptMessageEntity,
  ProdMaintenanceWriteEntity,
} from '../persistence/entities';
import { ProdDiagnosticsService } from './prod-diagnostics.service';

/**
 * The `atlas-prod` host-bridge MCP's backend module — `@Global` so `AgentSessionManager`'s `buildTools`
 * gate (a sibling thread) can inject `ProdDiagnosticsService` without a direct import edge. Registers
 * repositories for the ledger + the messages table (the card's durable-persist path) against the app's
 * OWN `DB_CONNECTION` — never the `mcp_reader`/`mcp_writer` pools, which `ProdDiagnosticsService` injects
 * directly via `@InjectDataSource`.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [ProdMaintenanceWriteEntity, TranscriptMessageEntity],
      DB_CONNECTION,
    ),
  ],
  providers: [ProdDiagnosticsService],
  exports: [ProdDiagnosticsService],
})
export class ProdDiagnosticsModule {}
