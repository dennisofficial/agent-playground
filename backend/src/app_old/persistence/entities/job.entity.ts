import type { Decision } from '../../../_shared/domain/decision-record';
import type { JobProvenance } from '../../../_shared/domain/job';
import type { AutoApproveMode, JobActivity, JobHalt, JobStatus } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { LiveVerificationVerdict } from '../../driver/live-verification-judge';
import { CiCounts } from '../../git/github-pr.service';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { UserEntity } from './user.entity';

export interface PipelineMarker {
  id: string;
  text: string;
  at: string;
}

export interface ThreadPipelineAwareness {
  markerQueue: PipelineMarker[];
  conveyedStateSig: string | null;
}

@Entity({ name: 'jobs' })
@Index(['org_id', 'repo_id'])
@Index(['created_by_job_id'])
export class JobEntity extends TimestampedEntity {
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

  @Column({ type: 'text' })
  origin!: string;

  @Column({ type: 'text', nullable: true })
  surface_thread_ref!: string | null;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  @Column({ type: 'text', nullable: true })
  base_branch!: string | null;

  @Column({ type: 'uuid', nullable: true })
  created_by_job_id!: string | null;

  @ManyToOne(() => JobEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_job_id' })
  createdByJob?: JobEntity | null;

  @Column({ type: 'jsonb', nullable: true })
  created_by!: JobProvenance | null;

  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  @Column({ type: 'text', default: 'open' })
  status!: string;

  @Column({ type: 'timestamptz', nullable: true })
  archived_at!: Date | null;

  @Column({ type: 'jsonb', default: {} })
  section_first_entered!: Partial<Record<JobStatus, string>>;

  @Column({ type: 'timestamptz', nullable: true })
  ship_review_approved_at!: Date | null;

  @Column({ type: 'text', default: 'idle' })
  activity!: JobActivity;

  @Column({ type: 'boolean', default: false })
  halted!: boolean;

  @Column({ type: 'int', default: 0 })
  open_question_count!: number;

  @Column({ type: 'text', nullable: true })
  awaiting_secret_id!: string | null;

  @Column({ type: 'int', default: 0 })
  open_secret_count!: number;

  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  @Column({ type: 'text', nullable: true })
  current_branch!: string | null;

  @Column({ type: 'text', nullable: true })
  port_state!: 'exposed' | 'internal' | null;

  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;

  @Column({ type: 'int', nullable: true })
  pr_number!: number | null;

  @Column({ type: 'text', nullable: true })
  ci_status!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  ci_counts!: CiCounts | null;

  @Column({ type: 'int', nullable: true })
  build_stages_done!: number | null;

  @Column({ type: 'int', nullable: true })
  build_stages_total!: number | null;

  @Column({ type: 'text', nullable: true })
  pr_mergeable!: string | null;

  @Column({ type: 'text', nullable: true })
  pr_state!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  next_poll_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  session_resume_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  benign_abort_redrives!: number;

  @Column({ type: 'int', default: 0 })
  transient_retry_redrives!: number;

  @Column({ type: 'int', default: 0 })
  auth_retry_attempts!: number;

  @Column({ type: 'int', default: 0 })
  driver_transient_retries!: number;

  @Column({ type: 'timestamptz', nullable: true })
  retry_last_attempt_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  session_limit_text_misfires!: number;

  @Column({
    type: 'jsonb',
    default: { markerQueue: [], conveyedStateSig: null },
  })
  pipeline_awareness!: ThreadPipelineAwareness;

  @Column({ type: 'jsonb', default: [] })
  pending_decisions!: Decision[];

  @Column({ type: 'jsonb', nullable: true })
  halt!: JobHalt | null;

  @Column({ type: 'jsonb', nullable: true })
  session_resume!: {
    lane: 'main' | 'build';
    reason: string;
    resetSource: 'usage_api' | 'parsed_string';
    kind?: 'session_limit' | 'retry';
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  direct_build_verification!: {
    verdict: LiveVerificationVerdict;
    at: string;
  } | null;

  @Column({ type: 'timestamptz', nullable: true })
  direct_build_started_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  build_path!: 'direct' | 'plan' | null;

  @Column({ type: 'text', default: 'off' })
  auto_approve_mode!: AutoApproveMode;

  @Column({ type: 'uuid', nullable: true })
  auto_approve_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'auto_approve_by' })
  autoApproveByUser?: UserEntity | null;

  @Column({ type: 'boolean', default: false })
  auto_merge!: boolean;

  @Column({ type: 'uuid', nullable: true })
  auto_merge_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'auto_merge_by' })
  autoMergeByUser?: UserEntity | null;
}
