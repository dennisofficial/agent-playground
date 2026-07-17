import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { DecisionRecordEntity } from './decision-record.entity';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'thread_groups' })
@Index(['job_id'])
@Index(['job_id', 'ordinal'])
export class ThreadGroupEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', default: 'pending' })
  status!: string;

  @Column({ type: 'text', default: 'none' })
  condition!: string;

  @Column({ type: 'uuid', nullable: true })
  @Index()
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;
}
