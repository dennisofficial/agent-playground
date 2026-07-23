import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
import { ETaskStatus } from '@workspace/shared';
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
import { ThreadGroup } from './thread-group.entity';

@Entity({ name: 'tasks' })
@Index(['threadGroupId'])
@Index(['threadGroupId', 'ordinal'])
@Index(['jobId'])
@Index(['orgId'])
@Rls<Task, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
@Realtime()
export class Task extends TimestampedEntity {
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
  @Expose()
  threadGroupId!: string;

  @ManyToOne(() => ThreadGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_group_id' })
  threadGroup?: ThreadGroup;

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'int' })
  @Expose()
  ordinal!: number;

  @Column({ type: 'text' })
  @Expose()
  title!: string;

  @Column({ type: 'text', nullable: true })
  @Expose()
  brief!: string | null;

  @Column({ type: 'text', nullable: true })
  @Expose()
  activeForm!: string | null;

  @Column({ type: 'enum', enum: ETaskStatus, default: ETaskStatus.PENDING })
  @Expose()
  status!: ETaskStatus;

  /** Ids of tasks that must complete before this one (dependency edges). */
  @Column({ type: 'jsonb', default: [] })
  @Expose()
  blockedBy!: string[];
}

export class TaskRepo extends Repository<Task> {}
