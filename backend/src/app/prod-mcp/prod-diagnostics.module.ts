import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { ProdMaintenanceWriteEntity, TranscriptMessageEntity } from '../persistence/entities';
import { ProdDiagnosticsService } from './prod-diagnostics.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ProdMaintenanceWriteEntity, TranscriptMessageEntity], DB_CONNECTION),
  ],
  providers: [ProdDiagnosticsService],
  exports: [ProdDiagnosticsService],
})
export class ProdDiagnosticsModule {}
