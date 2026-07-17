import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'org_invites' })
@Index(['org_id'])
@Index(['email'])
@Index(['token'], { unique: true })
export class OrgInviteEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  token!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'text' })
  email!: string;

  @Column({ type: 'text', default: 'member' })
  role!: string;

  @Column({ type: 'uuid', nullable: true })
  invited_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'invited_by' })
  invitedByUser?: UserEntity | null;

  @Column({ type: 'timestamptz', nullable: true })
  accepted_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  accepted_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'accepted_by' })
  acceptedByUser?: UserEntity | null;
}
