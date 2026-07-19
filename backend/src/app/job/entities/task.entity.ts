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
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';
import { Job } from './job.entity';
import { ThreadGroup } from './thread-group.entity';

@Entity({ name: 'tasks' })
@Index(['threadGroupId'])
@Index(['threadGroupId', 'ordinal'])
@Index(['jobId'])
@Index(['orgId'])
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

/** Injectable DI token / typed alias for the Task repository. */
export class TaskRepo extends Repository<Task> {}
