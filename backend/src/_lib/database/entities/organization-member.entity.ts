import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
import { EOrgRole } from '@workspace/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Repository } from 'typeorm';
import { Organization } from './organization.entity';
import { User } from './user.entity';

@Entity({ name: 'organization_members' })
@Index(['userId'])
@Rls<OrganizationMember, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
export class OrganizationMember extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: User;

  @Column({ type: 'enum', enum: EOrgRole, default: EOrgRole.MEMBER })
  role!: EOrgRole;
}

export class OrganizationMemberRepo extends Repository<OrganizationMember> {}
