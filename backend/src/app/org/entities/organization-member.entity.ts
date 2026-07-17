import { EOrgRole } from '@workspace/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { User } from '../../auth/entities/user.entity';
import { Organization } from './organization.entity';

/** Join table: which users belong to which orgs, and in what role. Composite PK (orgId, userId). */
@Entity({ name: 'organization_members' })
@Index(['userId'])
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

/** Injectable DI token / typed alias for the OrganizationMember repository. */
export class OrganizationMemberRepo extends Repository<OrganizationMember> {}
