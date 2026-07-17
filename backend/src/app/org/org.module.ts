import { CreateModule } from '@workspace/nestjs-core';
import { REALTIME_MODEL, realtimeModelProvider } from '../../_lib/realtime/realtime.tokens';
import { OrganizationMember, OrganizationMemberRepo } from './entities/organization-member.entity';
import { Organization, OrganizationRepo } from './entities/organization.entity';
import { OrgController } from './org.controller';
import { buildOrgRealtimeModels } from './org.realtime';
import { OrgService } from './org.service';

@CreateModule({
  entities: [
    { entity: Organization, repoClass: OrganizationRepo },
    { entity: OrganizationMember, repoClass: OrganizationMemberRepo },
  ],
  services: [OrgService],
  controllers: [OrgController],
  providers: [
    // Contribute the org read-feeds (organizations + organization_members) to the realtime engine.
    realtimeModelProvider(
      (members: OrganizationMemberRepo) => buildOrgRealtimeModels(members),
      [OrganizationMemberRepo],
    ),
  ],
  exports: [REALTIME_MODEL],
})
export class OrgModule {}
