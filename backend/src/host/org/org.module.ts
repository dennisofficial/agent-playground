import { CreateModule } from '@workspace/nestjs-core';
import { RLS_CONTEXT, type RlsContextConfig } from '@workspace/nestjs-rls/nest';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import {
  OrganizationMember,
  OrganizationMemberRepo,
} from '../../_lib/database/entities/organization-member.entity';
import { Organization, OrganizationRepo } from '../../_lib/database/entities/organization.entity';
import { OrgController } from './org.controller';
import { buildOrgRealtimeModels } from './org.realtime';
import { OrgService } from './org.service';

@CreateModule({
  imports: [
    PgRealtimeModule.forFeature({
      inject: [RLS_CONTEXT],
      useFactory: (ctx: RlsContextConfig) => buildOrgRealtimeModels(ctx.resolveClaims),
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
