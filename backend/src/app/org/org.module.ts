import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  OrganizationEntity,
  OrganizationMemberEntity,
  OrgInviteEntity,
  UserEntity,
} from '../persistence/entities';
import { InviteController } from './invite.controller';
import { OrgMembershipGuard } from './org-membership.guard';
import { OrgOwnerGuard } from './org-owner.guard';
import { OrgController } from './org.controller';
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
      [OrganizationEntity, OrganizationMemberEntity, OrgInviteEntity, UserEntity],
      DB_CONNECTION,
    ),
  ],
  controllers: [OrgController, InviteController],
  providers: [OrganizationService, OrgMembershipGuard, OrgOwnerGuard],
  exports: [OrganizationService, OrgMembershipGuard, OrgOwnerGuard],
})
export class OrgModule {}
