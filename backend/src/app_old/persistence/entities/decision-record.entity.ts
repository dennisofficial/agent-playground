import type { Decision } from '../../../_shared/domain/decision-record';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'decision_records' })
@Index(['org_id', 'repo_id'])
@Index(['job_id'])
export class DecisionRecordEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  @Column({ type: 'text', default: 'draft' })
  status!: string;

  @Column({ type: 'text' })
  overview!: string;

  @Column({ type: 'jsonb', default: [] })
  decisions!: Decision[];

  @Column({ type: 'text', array: true, default: () => `'{}'` })
  thread_titles!: string[];

  @Column({ type: 'uuid', nullable: true })
  approved_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'approved_by' })
  approvedByUser?: UserEntity | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;
}
