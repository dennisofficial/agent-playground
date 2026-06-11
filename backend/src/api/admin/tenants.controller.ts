import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantViewStore } from '../../harness/tenants/tenant-view.store';
import { AdminTokenGuard } from './admin-token.guard';

/**
 * Lists all registered workspaces/teams — powers the workspace picker at the top of the
 * Memory Viewer UI. No `:teamId` param; this is a global, cross-tenant listing.
 */
@Controller('tenants')
@UseGuards(AdminTokenGuard)
export class TenantsController {
  constructor(private readonly store: TenantViewStore) {}

  /** All registered workspaces, sorted by display name. Returns `{ id, name, slug }[]`. */
  @Get()
  list() {
    return this.store.list();
  }
}
