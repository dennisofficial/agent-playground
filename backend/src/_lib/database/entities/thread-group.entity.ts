import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
import { EThreadCondition, EThreadGroupKind, EThreadStatus } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { Job } from './job.entity';
import { Organization } from './organization.entity';

@Entity({ name: 'thread_groups' })
@Index(['jobId'])
@Index(['jobId', 'ordinal'])
@Index(['orgId'])
@Rls<ThreadGroup, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
@Realtime()
export class ThreadGroup extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

  @Column({ type: 'uuid' })
  @Expose()
  jobId!: string;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Job;

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'int' })
  @Expose()
  ordinal!: number;

  @Column({ type: 'enum', enum: EThreadGroupKind })
  @Expose()
  kind!: EThreadGroupKind;

  @Column({ type: 'text', nullable: true })
  @Expose()
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  @Expose()
  type!: string | null;

  @Column({ type: 'enum', enum: EThreadStatus, default: EThreadStatus.PENDING })
  @Expose()
  status!: EThreadStatus;

  @Column({ type: 'enum', enum: EThreadCondition, default: EThreadCondition.NONE })
  @Expose()
  condition!: EThreadCondition;
}

export class ThreadGroupRepo extends Repository<ThreadGroup> {}
