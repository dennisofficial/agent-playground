import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { ExposureService } from './exposure.service';

/**
 * The sandbox-preview EXPOSURE seam — a single @Global service that drives Caddy to publish live
 * dev-servers at deterministic preview URLs. Depends on `SANDBOX_PROVIDER` + `CaddyAdminClient` (both
 * @Global), so it provides only `ExposureService` and imports nothing: the tokens resolve ambiently.
 * @Global so the web surface (per-poll reconcile + URL rendering) and the driver reap timer (periodic
 * `reconcileAll`) inject it without an import edge.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([JobEntity], DB_CONNECTION)],
  providers: [ExposureService],
  exports: [ExposureService],
})
export class ExposureModule {}
