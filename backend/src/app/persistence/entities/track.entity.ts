import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { ThreadEntity } from './thread.entity';

/**
 * One TRACK of a thread's build — a SCOPE-TYPED slice (backend/frontend/docs/testing/analytics/infra)
 * that becomes a set of steps and is reviewed by agents matched to its `type`. Tracks stack on the
 * thread's one feature branch and run sequentially (ORDER BY ordinal). `status` is the explicit,
 * resumable cursor. Gap-numbered ordinals so a re-plan can splice without renumbering.
 */
@Entity({ name: 'tracks' })
@Index(['thread_id'])
@Unique(['thread_id', 'ordinal'])
export class TrackEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning thread (FK → threads.id). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The one-line brief (title) from the upfront track list. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The scope TYPE of this track (backend/frontend/docs/testing/analytics/infra/…) — selects the
   * review agents that check it. A fixed vocabulary (TRACK_TYPES) with an allow-other escape hatch;
   * defaults to 'general' for arg-less callers (bugfix/direct build).
   */
  @Column({ type: 'text', default: 'general' })
  type!: string;

  /** The detailed plan once authored/generated; null while pending. Steps LOCK once planned. */
  @Column({ type: 'text', nullable: true })
  plan!: string | null;

  /** The prior track's handoff note threaded into this track's plan prompt. */
  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  /** This track's handoff note for the next track; null until done. */
  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;

  // 'pending' | 'planning' | 'reviewing' | 'awaiting_approval' | 'executing' | 'auto_fixing' | 'done' | 'failed'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /**
   * The post-build review agents (lenses) and their per-agent status — seeded when the track enters
   * `auto_fixing`, transitioned by the auto-fix stage, surfaced by `getPipelineState` so the navigator's
   * review folder can show each agent's state. `[]` until the track is reviewed (getPipelineState falls
   * back to the default lens set for an empty array). LITERAL default — a `() => '[]'::jsonb` function
   * default makes `migration:generate` loop forever (see the jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: [] })
  review_agents!: ReviewAgentState[];
}

/** One post-build review agent's persisted state on a track. */
export interface ReviewAgentState {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  findings?: number;
}
