import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { UserEntity } from './user.entity';

/**
 * Membership of a user in an organization — the spine linking `users` to `organizations`.
 * Composite PK (org_id, user_id): a user belongs to many orgs, an org has many users. `role` is `owner`
 * (the creator — may ADMINISTER: credentials, repos, invites, settings) or `member` (may OPERATE: use
 * the org's threads). Enforced by `OrgOwnerGuard`.
 */
@Entity({ name: 'organization_members' })
@Index(['user_id'])
export class OrganizationMemberEntity extends TimestampedEntity {
  /** FK → organizations.id */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** FK → users.id */
  @PrimaryColumn({ type: 'uuid' })
  user_id!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user?: UserEntity;

  /** 'owner' (the creator) | 'member'. */
  @Column({ type: 'text', default: 'member' })
  role!: string;
}
