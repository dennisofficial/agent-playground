import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A JOB = an ordered list of sections on ONE feature branch. A feature is many sections, a bugfix is
 * one — same deterministic driver. `status` is the EXPLICIT, resumable cursor (NOT an implicit FSM
 * re-derived from sibling rows): the driver re-enters at the right place on restart by reading it +
 * the section/phase rows. No board/backlog tables — a job stands on its own.
 */
@Entity({ name: 'jobs' })
@Index(['org_id', 'repo_id'])
@Index(['org_id', 'status'])
export class JobEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id). */
  @Column({ type: 'text' })
  org_id!: string;

  /** The project this job builds against. */
  @Column({ type: 'text' })
  repo_id!: string;

  /** The thread the job's chatter lives in (FK → threads). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  /** 'feature' (many sections) | 'bugfix' (one section, one phase). */
  @Column({ type: 'text', default: 'feature' })
  kind!: string;

  // 'scoping' | 'awaiting_approval' | 'running' | 'done' | 'failed' | 'cancelled'
  @Column({ type: 'text', default: 'scoping' })
  status!: string;

  @Column({ type: 'text' })
  title!: string;

  /** The locked decision record (FK → decision_records); null until the upfront grill produces one. */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  /** The feature branch all sections stack on; null until the sandbox is cut. */
  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  /** The opened PR url; null until the PR-tail stage opens one. */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;
}
