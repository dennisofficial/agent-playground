import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
import { EJobKind, EJobStatus, EThreadOrigin } from '@workspace/shared';
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
@Rls<Job, AtlasClaims>((c, action) => {
  switch (action) {
    case 'read':
      return { orgId: { $in: c.orgIds }, archivedAt: null };
    default:
      return { orgId: { $in: c.orgIds } };
  }
})
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

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;
}

export class JobRepo extends Repository<Job> {}
