import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A pending invitation to join an org. The `token` is the capability in the copy-paste invite link
 * (`<FRONTEND_HOST>/invites/<token>`); accepting it (while logged in) creates the `organization_members`
 * row. `email` is the intended recipient — informational for the copy-paste flow (the link is the secret),
 * matched against the accepting user when real email delivery is wired later.
 */
@Entity({ name: 'atlas_org_invites' })
@Index(['org_id'])
@Index(['email'])
export class AtlasOrgInvite extends TimestampedEntity {
  /** The invite token — the capability embedded in the invite link. */
  @PrimaryColumn({ type: 'text' })
  token!: string;

  /** FK → atlas_organizations.id */
  @Column({ type: 'text' })
  org_id!: string;

  /** The intended recipient's email. */
  @Column({ type: 'text' })
  email!: string;

  /** The role the invitee gets on accept. */
  @Column({ type: 'text', default: 'member' })
  role!: string;

  /** The member who created the invite (user id). */
  @Column({ type: 'text' })
  invited_by!: string;

  /** Set once redeemed; a non-null value means the invite is spent. */
  @Column({ type: 'timestamptz', nullable: true })
  accepted_at!: Date | null;

  /** The user who accepted (user id); null until redeemed. */
  @Column({ type: 'text', nullable: true })
  accepted_by!: string | null;
}
