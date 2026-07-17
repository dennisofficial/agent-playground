import { CreateModule } from '@workspace/nestjs-core';
import {
  OrganizationMember,
  OrganizationMemberRepo,
} from './entities/organization-member.entity';
import { Organization, OrganizationRepo } from './entities/organization.entity';
import { OrgController } from './org.controller';
import { OrganizationService } from './organization.service';

@CreateModule({
  entities: [
    { entity: Organization, repoClass: OrganizationRepo },
    { entity: OrganizationMember, repoClass: OrganizationMemberRepo },
  ],
  services: [OrganizationService],
  controllers: [OrgController],
})
export class OrgModule {}
