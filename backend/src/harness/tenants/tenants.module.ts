import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { Tenant } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { TenantViewStore } from './tenant-view.store';

/**
 * Slim, harness-free module that exposes `TenantViewStore` for the admin API.
 * No secret columns; no write paths. Requires the host app's @Global `DatabaseModule`.
 *
 * Intentionally separate from `MemoryAdminModule` — tenant listing is a general admin
 * concern, not specific to the memory viewer.
 */
@CreateModule({
  imports: [TypeOrmModule.forFeature([Tenant])],
  services: [
    {
      provide: TenantViewStore,
      inject: [getRepositoryToken(Tenant)],
      useFactory: (repo: Repository<Tenant>) => new TenantViewStore(repo),
    },
  ],
})
export class TenantsModule {}
