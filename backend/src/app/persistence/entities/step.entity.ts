import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { TrackEntity } from './track.entity';
import { JobEntity } from './job.entity';

/**
 * One STEP of a track's plan — runs as a FRESH session on the feature branch (fresh context per step
 * keeps the window small + avoids hallucination; the shared checkout lets later steps build on earlier
 * code). `stage` + `status` are the EXPLICIT, resumable cursor — the deterministic driver re-enters
 * here on restart rather than re-deriving control flow from statuses. Strictly sequential within a
 * track; gap-numbered.
 */
@Entity({ name: 'steps' })
@Index(['track_id'])
@Index(['thread_id'])
@Unique(['track_id', 'ordinal'])
export class StepEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning track (FK → tracks.id). */
  @Column({ type: 'uuid' })
  track_id!: string;

  @ManyToOne(() => TrackEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'track_id' })
  track?: TrackEntity;

  /** The owning thread (denormalized for thread-scoped boot recovery; FK → threads.id). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: JobEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Execution order within the track, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The step title from the plan, if any. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The step brief/instructions from the locked plan. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The EXPLICIT resumable stage within the step — the driver re-enters here after a restart instead
   * of re-deriving control flow. E.g. 'build' | 'review' | 'fix'.
   */
  @Column({ type: 'text', default: 'build' })
  stage!: string;

  // 'pending' | 'building' | 'reviewing' | 'done' | 'failed' | 'skipped'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The engine session this step runs inside; null until started. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  /**
   * Which execution BATCH this step belongs to within its track. A fresh-context step packs the ordered
   * steps into consecutive groups; every step in one group runs in ONE engine session. Null until the
   * track first executes; assigned + persisted then so a resumed/restarted track re-groups IDENTICALLY
   * — the resume cursor keys off the group's anchor step `session_id`, so batch membership MUST be
   * stable across a restart.
   */
  @Column({ type: 'int', nullable: true })
  batch_ordinal!: number | null;

  /**
   * Set on the batch ANCHOR step the instant its batch commits, BEFORE the per-step `status='done'`
   * writes — the atomic-resume marker. Non-null ⇒ the batch already committed, so a resume fast-forwards
   * (marks steps done) instead of re-running against an already-committed tree. Sentinel `(nothing)` =
   * "committed, empty diff". Null on non-anchor steps and before commit.
   */
  @Column({ type: 'text', nullable: true })
  commit_sha!: string | null;
}
