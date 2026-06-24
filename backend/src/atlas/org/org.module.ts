import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import {
  AtlasOrgInvite,
  AtlasUser,
  Organization,
  OrganizationMember,
} from '../persistence/entities';
import { InviteController } from './invite.controller';
import { OrgController } from './org.controller';
import { OrgMembershipGuard } from './org-membership.guard';
import { OrganizationService } from './organization.service';

/**
 * Organizations + membership. `@Global` so any module hosting an org-scoped controller can `@UseGuards`
 * the `OrgMembershipGuard` and inject `OrganizationService` without re-importing. Onboarding/repo/thread
 * controllers live in their own modules but gate on this guard.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Organization, OrganizationMember, AtlasOrgInvite, AtlasUser],
      ATLAS_CONNECTION,
    ),
  ],
  controllers: [OrgController, InviteController],
  providers: [OrganizationService, OrgMembershipGuard],
  exports: [OrganizationService, OrgMembershipGuard],
})
export class OrgModule {}
