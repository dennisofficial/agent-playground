import type { AutoMergeMethod } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { SeenTooling } from '../../workspace-profile/seen-tooling';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'repos' })
@Index(['org_id'])
@Unique(['org_id', 'slug'])
export class RepoEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  git_url!: string;

  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  @Column({ type: 'text', nullable: true })
  branch_prefix!: string | null;

  @Column({ type: 'text', nullable: true })
  branch_regex!: string | null;

  @Column({ type: 'text', nullable: true })
  setup_script!: string | null;

  @Column({ type: 'text', nullable: true })
  preview_instructions!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  profile_seen_manifests!: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  profile_seen_tooling!: SeenTooling[] | null;

  @Column({ type: 'text', nullable: true })
  token_name!: string | null;

  @Column({ type: 'text', nullable: true })
  convention_profile_slug!: string | null;

  @Column({ type: 'text', default: 'squash' })
  default_auto_merge_method!: AutoMergeMethod;

  @Column({ type: 'boolean', default: true })
  default_auto_merge_delete_branch!: boolean;

  @Column({ type: 'boolean', default: false })
  access_ok!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  access_checked_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  onboarding_job_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  onboarded_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  webhook_warning!: string | null;
}
