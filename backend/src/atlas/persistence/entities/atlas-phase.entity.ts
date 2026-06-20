import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * One PHASE of a section's locked plan — runs as a FRESH session on the feature branch (fresh context
 * per phase keeps the window <300k and avoids hallucination; the shared checkout lets later phases
 * build on earlier code). `step` + `status` are the EXPLICIT, resumable cursor — the deterministic
 * driver re-enters here on restart rather than re-deriving control flow from statuses (the whole
 * point of v2 vs. v1's implicit status-FSM). Strictly sequential within a section; gap-numbered.
 */
@Entity({ name: 'atlas_phases' })
@Index(['section_id'])
@Index(['job_id'])
@Unique(['section_id', 'ordinal'])
export class AtlasPhase extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning section (FK → atlas_sections). */
  @Column({ type: 'uuid' })
  section_id!: string;

  /** The owning job (denormalized for job-scoped boot recovery / awareness queries). */
  @Column({ type: 'uuid' })
  job_id!: string;

  /** The tenant (Slack team id) — denormalized for team-scoped queries. */
  @Column({ type: 'text' })
  team_id!: string;

  /** Execution order within the section, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The phase title from the plan, if any. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The phase brief/instructions from the locked plan. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The EXPLICIT resumable step within the phase — the driver re-enters here after a restart instead
   * of re-deriving control flow. E.g. 'build' | 'review' | 'fix'.
   */
  @Column({ type: 'text', default: 'build' })
  step!: string;

  // 'pending' | 'building' | 'reviewing' | 'done' | 'failed' | 'skipped'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The engine session this phase runs inside; null until started. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;
}
