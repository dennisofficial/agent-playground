import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

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
  @PrimaryColumn({ type: 'text' })
  org_id!: string;

  /** FK → users.id */
  @PrimaryColumn({ type: 'text' })
  user_id!: string;

  /** 'owner' (the creator) | 'member'. */
  @Column({ type: 'text', default: 'member' })
  role!: string;
}
