import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'convention_profiles' })
@Index(['org_id'])
export class ConventionProfileEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @PrimaryColumn({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: 'text', nullable: true })
  detect_hint!: string | null;
}
