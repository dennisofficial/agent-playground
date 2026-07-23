import { CreateModule } from '@workspace/nestjs-core';
import {
  OrganizationMember,
  OrganizationMemberRepo,
} from '../../_lib/database/entities/organization-member.entity';
import { Organization, OrganizationRepo } from '../../_lib/database/entities/organization.entity';
import { OrgRealtimeResourcesService } from './org-realtime-resources.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

@CreateModule({
  entities: [
    { entity: Organization, repoClass: OrganizationRepo },
    { entity: OrganizationMember, repoClass: OrganizationMemberRepo },
  ],
  services: [OrgService, OrgRealtimeResourcesService],
  controllers: [OrgController],
})
export class OrgModule {}
