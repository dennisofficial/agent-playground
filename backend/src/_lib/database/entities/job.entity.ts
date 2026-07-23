import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Expose, Rls } from '@workspace/nestjs-rls';
import { Realtime } from '@workspace/pg-realtime/nest-realtime';
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
@Realtime()
export class Job extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  @Expose()
  id!: string;

  @Column({ type: 'uuid' })
  @Expose() // kept for the guard scope
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'uuid' })
  @Expose()
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: Repo;

  @Column({ type: 'uuid', nullable: true })
  @Expose()
  focusedThreadId!: string | null;

  @ManyToOne(() => Thread, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'focused_thread_id' })
  focusedThread?: Thread | null;

  @Column({ type: 'text', nullable: true })
  @Expose()
  title!: string | null;

  @Column({ type: 'enum', enum: EThreadOrigin, default: EThreadOrigin.CHAT })
  @Expose()
  origin!: EThreadOrigin;

  @Column({ type: 'enum', enum: EJobKind, nullable: true })
  @Expose()
  kind!: EJobKind | null;

  @Column({ type: 'enum', enum: EJobStatus, default: EJobStatus.OPEN })
  @Expose()
  status!: EJobStatus;

  @Column({ type: 'timestamptz', nullable: true })
  @Expose()
  archivedAt!: Date | null;

  // Redeclared (no @Column — inherited from TimestampedEntity) purely to attach @Expose;
  // TypeORM's own column metadata is untouched.
  @Expose()
  declare createdAt: Date;

  @Expose()
  declare updatedAt: Date;
}

export class JobRepo extends Repository<Job> {}
