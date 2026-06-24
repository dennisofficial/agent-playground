import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { Organization, OrganizationMember } from '../persistence/entities';
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
    TypeOrmModule.forFeature([Organization, OrganizationMember], ATLAS_CONNECTION),
  ],
  controllers: [OrgController],
  providers: [OrganizationService, OrgMembershipGuard],
  exports: [OrganizationService, OrgMembershipGuard],
})
export class OrgModule {}
