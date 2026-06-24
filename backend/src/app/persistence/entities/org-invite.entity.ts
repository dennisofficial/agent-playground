import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { UserEntity } from './user.entity';

/**
 * A pending invitation to join an org. The `token` is the capability in the copy-paste invite link
 * (`<FRONTEND_HOST>/invites/<token>`); accepting it (while logged in) creates the `organization_members`
 * row. `email` is the intended recipient — informational for the copy-paste flow (the link is the secret),
 * matched against the accepting user when real email delivery is wired later.
 */
@Entity({ name: 'org_invites' })
@Index(['org_id'])
@Index(['email'])
@Index(['token'], { unique: true })
export class OrgInviteEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The invite token — the capability embedded in the invite link (unique). */
  @Column({ type: 'text' })
  token!: string;

  /** FK → organizations.id */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The intended recipient's email. */
  @Column({ type: 'text' })
  email!: string;

  /** The role the invitee gets on accept. */
  @Column({ type: 'text', default: 'member' })
  role!: string;

  /** The member who created the invite (FK → users.id; SET NULL if that user is deleted). */
  @Column({ type: 'uuid', nullable: true })
  invited_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by' })
  invitedByUser?: UserEntity | null;

  /** Set once redeemed; a non-null value means the invite is spent. */
  @Column({ type: 'timestamptz', nullable: true })
  accepted_at!: Date | null;

  /** The user who accepted (FK → users.id); null until redeemed. */
  @Column({ type: 'uuid', nullable: true })
  accepted_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'accepted_by' })
  acceptedByUser?: UserEntity | null;
}
