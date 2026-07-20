import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
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
export class Task extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  jobId!: string;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Job;

  @Column({ type: 'uuid' })
  threadGroupId!: string;

  @ManyToOne(() => ThreadGroup, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_group_id' })
  threadGroup?: ThreadGroup;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  brief!: string | null;

  @Column({ type: 'text', nullable: true })
  activeForm!: string | null;

  @Column({ type: 'enum', enum: ETaskStatus, default: ETaskStatus.PENDING })
  status!: ETaskStatus;

  /** Ids of tasks that must complete before this one (dependency edges). */
  @Column({ type: 'jsonb', default: [] })
  blockedBy!: string[];
}

export class TaskRepo extends Repository<Task> {}
