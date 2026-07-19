import { EThreadCondition, EThreadRole, EThreadStatus, EThreadType } from '@workspace/shared';
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

@Entity({ name: 'threads' })
@Index(['jobId'])
@Index(['threadGroupId'])
@Index(['parentThreadId'])
@Index(['orgId'])
export class Thread extends TimestampedEntity {
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

  /** The parent lane this one nests under (review children), or null for a top-level lane. */
  @Column({ type: 'uuid', nullable: true })
  parentThreadId!: string | null;

  @ManyToOne(() => Thread, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_thread_id' })
  parent?: Thread | null;

  @Column({ type: 'enum', enum: EThreadRole })
  role!: EThreadRole;

  @Column({ type: 'enum', enum: EThreadType, default: EThreadType.GENERAL })
  type!: EThreadType;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  brief!: string;

  @Column({ type: 'enum', enum: EThreadStatus, default: EThreadStatus.PENDING })
  status!: EThreadStatus;

  @Column({ type: 'enum', enum: EThreadCondition, default: EThreadCondition.NONE })
  condition!: EThreadCondition;

  @Column({ type: 'text', nullable: true })
  sessionId!: string | null;
}

/** Injectable DI token / typed alias for the Thread repository. */
export class ThreadRepo extends Repository<Thread> {}
