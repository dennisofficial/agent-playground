import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import type { ReviewFinding } from '../../autofix/autofix.types';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';
import { ThreadGroupEntity } from './thread-group.entity';

@Entity({ name: 'threads' })
@Index(['job_id'])
@Index(['thread_group_id'])
@Index(['parent_thread_id'])
@Index('uq_threads_job_parent_ordinal', { synchronize: false })
export class ThreadEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  @Column({ type: 'uuid' })
  thread_group_id!: string;

  @ManyToOne(() => ThreadGroupEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_group_id' })
  threadGroup?: ThreadGroupEntity;

  @Column({ type: 'text' })
  role!: string;

  @Column({ type: 'uuid', nullable: true })
  parent_thread_id!: string | null;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_thread_id' })
  parent?: ThreadEntity | null;

  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  review_findings!: ReviewFinding[] | null;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'int' })
  ordinal!: number;

  @Column({ type: 'text' })
  brief!: string;

  @Column({ type: 'text', default: 'general' })
  type!: string;

  @Column({ type: 'text', nullable: true })
  plan!: string | null;

  @Column({ type: 'text', nullable: true })
  orientation!: string | null;

  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;

  @Column({ type: 'text', default: 'pending' })
  status!: string;

  @Column({ type: 'text', default: 'none' })
  condition!: string;

  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  @Column({ type: 'text', nullable: true })
  commit_sha!: string | null;

  @Column({ type: 'jsonb', default: [] })
  deviations!: DeviationEntry[];

  @Column({ type: 'jsonb', nullable: true })
  terminal_record!: ThreadTerminalRecord | null;

  @Column({ type: 'text', nullable: true })
  start_sha!: string | null;
}

export interface SessionAnchor {
  sessionId: string;
  legOrdinal?: number;
}

export interface ThreadTerminalRecord {
  status: 'done';
  summary: string;
  changes?: string[];
  verification?: {
    kind: string;
    command: string;
    exitCode: number;
    outputTail: string;
  }[];
  deviations?: string[];
  gaps?: string[];
}

export interface DeviationEntry {
  note: string;
  ts: string;
}

export interface ReviewAgentState {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  findings?: number;
}

export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  description?: string;
  activeForm?: string;
  blockedBy?: string[];
}
