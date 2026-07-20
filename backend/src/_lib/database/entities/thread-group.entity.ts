import { TimestampedEntity } from '@lib/database/base.entity';
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
export class ThreadGroup extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  jobId!: string;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Job;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'enum', enum: EThreadGroupKind })
  kind!: EThreadGroupKind;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'enum', enum: EThreadStatus, default: EThreadStatus.PENDING })
  status!: EThreadStatus;

  @Column({ type: 'enum', enum: EThreadCondition, default: EThreadCondition.NONE })
  condition!: EThreadCondition;
}

export class ThreadGroupRepo extends Repository<ThreadGroup> {}
