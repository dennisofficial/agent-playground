import { TimestampedEntity } from '@lib/database/base.entity';
import { EJobActivity, EJobKind, EJobStatus, EThreadOrigin } from '@workspace/shared';
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
import { Repo } from './repo.entity';
import { Thread } from './thread.entity';

@Entity({ name: 'jobs' })
@Index(['orgId', 'repoId'])
export class Job extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'uuid' })
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: Repo;

  /** The thread a job click routes to by default; null until the first thread exists. `SET NULL` so
   *  deleting the focused thread nulls the pointer rather than dangling. */
  @Column({ type: 'uuid', nullable: true })
  focusedThreadId!: string | null;

  @ManyToOne(() => Thread, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'focused_thread_id' })
  focusedThread?: Thread | null;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'enum', enum: EThreadOrigin, default: EThreadOrigin.CHAT })
  origin!: EThreadOrigin;

  @Column({ type: 'enum', enum: EJobKind, nullable: true })
  kind!: EJobKind | null;

  @Column({ type: 'enum', enum: EJobStatus, default: EJobStatus.OPEN })
  status!: EJobStatus;

  @Column({ type: 'enum', enum: EJobActivity, default: EJobActivity.IDLE })
  activity!: EJobActivity;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;
}

export class JobRepo extends Repository<Job> {}
