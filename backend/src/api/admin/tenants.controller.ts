import { Controller, Get, UseGuards } from '@nestjs/common';
import { type TenantView } from '@workspace/shared';
import { TenantViewStore } from '../../harness/tenants/tenant-view.store';
import { AdminAuthGuard } from '../auth/admin-auth.guard';

/**
 * Lists all registered workspaces/teams — powers the workspace picker at the top of the
 * Memory Viewer UI. No `:teamId` param; this is a global, cross-tenant listing.
 */
@Controller('tenants')
@UseGuards(AdminAuthGuard)
export class TenantsController {
  constructor(private readonly store: TenantViewStore) {}

  /** All registered workspaces, sorted by display name. Returns `{ id, name, slug }[]`. */
  @Get()
  list(): Promise<TenantView[]> {
    return this.store.list();
  }
}
