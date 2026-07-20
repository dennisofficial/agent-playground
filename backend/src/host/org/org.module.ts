import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { CreateModule } from '@workspace/nestjs-core';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import type { Repository } from 'typeorm';
import { OrganizationMember, OrganizationMemberRepo } from './entities/organization-member.entity';
import { Organization, OrganizationRepo } from './entities/organization.entity';
import { OrgController } from './org.controller';
import { buildOrgRealtimeModels } from './org.realtime';
import { OrgService } from './org.service';

@CreateModule({
  imports: [
    // Contribute the org read-feeds (organizations + organization_members) to the realtime engine.
    // Sources the members repo via TypeOrmModule.forFeature (not OrgModule) so the contribution module
    // doesn't import OrgModule and cause a self-cycle.
    PgRealtimeModule.forFeature({
      imports: [TypeOrmModule.forFeature([OrganizationMember])],
      inject: [getRepositoryToken(OrganizationMember)],
      useFactory: (members: Repository<OrganizationMember>) => buildOrgRealtimeModels(members),
    }),
  ],
  entities: [
    { entity: Organization, repoClass: OrganizationRepo },
    { entity: OrganizationMember, repoClass: OrganizationMemberRepo },
  ],
  services: [OrgService],
  controllers: [OrgController],
})
export class OrgModule {}
