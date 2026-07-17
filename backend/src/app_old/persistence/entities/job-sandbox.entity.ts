import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

@Entity({ name: 'job_sandboxes' })
@Index(['job_id'], { unique: true })
export class JobSandboxEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  @Column({ type: 'text' })
  worktree_path!: string;

  @Column({ type: 'text', nullable: true })
  container_id!: string | null;

  @Column({ type: 'text', default: 'provisioning' })
  lifecycle!: string;

  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  @Column({ type: 'text', nullable: true })
  pending_compaction_seed!: string | null;

  @Column({ type: 'text', nullable: true })
  compacting_session_id!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  last_active_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  hydration_sig!: string | null;

  @Column({ type: 'text', nullable: true })
  setup_error!: string | null;
}
