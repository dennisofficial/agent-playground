import { TimestampedEntity } from '@workspace/shared/schemas';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

@Entity({ name: 'job_dependencies' })
@Index(['org_id', 'repo_id'])
@Index(['depends_on_job_id'])
@Unique(['job_id', 'depends_on_job_id'])
export class JobDependencyEntity extends TimestampedEntity {
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
  job?: JobEntity;

  @Column({ type: 'uuid' })
  depends_on_job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'depends_on_job_id' })
  dependsOnJob?: JobEntity;
}
