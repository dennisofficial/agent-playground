import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
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
import { Job } from './job.entity';
import { Organization } from './organization.entity';
import { ThreadGroup } from './thread-group.entity';

@Entity({ name: 'threads' })
@Index(['jobId'])
@Index(['threadGroupId'])
@Index(['parentThreadId'])
@Index(['orgId'])
@Rls<Thread, AtlasClaims>((c) => ({ orgId: { $in: c.orgIds } }))
@Realtime()
export class Thread extends TimestampedEntity {
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

  /** The parent lane this one nests under (review children), or null for a top-level lane. */
  @Column({ type: 'uuid', nullable: true })
  @Expose()
  parentThreadId!: string | null;

  @ManyToOne(() => Thread, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_thread_id' })
  parent?: Thread | null;

  @Column({ type: 'enum', enum: EThreadRole })
  @Expose()
  role!: EThreadRole;

  @Column({ type: 'enum', enum: EThreadType, default: EThreadType.GENERAL })
  @Expose()
  type!: EThreadType;

  @Column({ type: 'int' })
  @Expose()
  ordinal!: number;

  @Column({ type: 'text' })
  @Expose()
  brief!: string;

  @Column({ type: 'enum', enum: EThreadStatus, default: EThreadStatus.PENDING })
  @Expose()
  status!: EThreadStatus;

  @Column({ type: 'enum', enum: EThreadCondition, default: EThreadCondition.NONE })
  @Expose()
  condition!: EThreadCondition;

  @Column({ type: 'text', nullable: true })
  @Expose()
  sessionId!: string | null;

  // Redeclared (no @Column — inherited from TimestampedEntity) purely to attach @Expose;
  // TypeORM's own column metadata is untouched.
  @Expose()
  declare createdAt: Date;

  @Expose()
  declare updatedAt: Date;
}

export class ThreadRepo extends Repository<Thread> {}
