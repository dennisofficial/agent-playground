import { Injectable } from '@nestjs/common';
import { OrgService } from '../org/org.service';
import { WorkspaceMountRepo } from './entities/workspace-mount.entity';

/**
 * Per-repo mount CRUD (the list half of the profile). SHELL this pass — deps wired, bodies deferred to the
 * logic pass (list / upsert / remove, tenancy via `orgs.assertMember`/`assertOwner`).
 */
@Injectable()
export class MountService {
  constructor(
    private readonly mounts: WorkspaceMountRepo,
    private readonly orgs: OrgService,
  ) {}
}
