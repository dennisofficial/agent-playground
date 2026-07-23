import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
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
import { Organization } from './organization.entity';

@Entity({ name: 'repos' })
@Index(['orgId'])
@Index(['orgId', 'slug'], { unique: true })
@Rls<Repo, AtlasClaims>((c, action) => ({
  orgId: { $in: action === 'read' ? c.orgIds : c.ownerOrgIds },
}))
@Realtime()
export class Repo extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Human-readable `owner/repo` identity, unique within the org. */
  @Column({ type: 'text' })
  @Expose()
  slug!: string;

  @Column({ type: 'text' })
  @Expose()
  name!: string;

  @Column({ type: 'text' })
  @Expose()
  gitUrl!: string;

  @Column({ type: 'text', default: 'main' })
  @Expose()
  defaultBranch!: string;

  /** Per-repo feature-branch prefix override; null → neutral built-in default. */
  @Column({ type: 'text', nullable: true })
  @Expose()
  branchPrefix!: string | null;

  @Column({ type: 'enum', enum: AUTO_MERGE_METHODS, default: 'squash' })
  @Expose()
  defaultAutoMergeMethod!: AutoMergeMethod;

  @Column({ type: 'boolean', default: true })
  @Expose()
  defaultAutoMergeDeleteBranch!: boolean;

  @Column({ type: 'boolean', default: false })
  @Expose()
  accessOk!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  @Expose()
  accessCheckedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  @Expose()
  webhookWarning!: string | null;

  @Column({ type: 'uuid', nullable: true })
  @Expose()
  onboardingThreadId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  @Expose()
  onboardedAt!: Date | null;

  /** Denormalized count of threads on this repo. 0 until the threads slice exists. */
  @Column({ type: 'int', default: 0 })
  @Expose()
  threadCount!: number;
}

export class RepoRepo extends Repository<Repo> {}
