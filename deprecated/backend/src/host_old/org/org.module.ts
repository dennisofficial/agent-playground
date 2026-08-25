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
