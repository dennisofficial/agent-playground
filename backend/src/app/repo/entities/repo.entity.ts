import { AUTO_MERGE_METHODS, type AutoMergeMethod } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';

@Entity({ name: 'repos' })
@Index(['orgId'])
@Index(['orgId', 'slug'], { unique: true })
export class Repo extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Human-readable `owner/repo` identity, unique within the org. */
  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  gitUrl!: string;

  @Column({ type: 'text', default: 'main' })
  defaultBranch!: string;

  /** Per-repo feature-branch prefix override; null → neutral built-in default. */
  @Column({ type: 'text', nullable: true })
  branchPrefix!: string | null;

  @Column({ type: 'enum', enum: AUTO_MERGE_METHODS, default: 'squash' })
  defaultAutoMergeMethod!: AutoMergeMethod;

  @Column({ type: 'boolean', default: true })
  defaultAutoMergeDeleteBranch!: boolean;

  @Column({ type: 'boolean', default: false })
  accessOk!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  accessCheckedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  webhookWarning!: string | null;

  @Column({ type: 'uuid', nullable: true })
  onboardingThreadId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  onboardedAt!: Date | null;

  /** Denormalized count of threads on this repo. 0 until the threads slice exists. */
  @Column({ type: 'int', default: 0 })
  threadCount!: number;
}

/** Injectable DI token / typed alias for the Repo repository. */
export class RepoRepo extends Repository<Repo> {}
