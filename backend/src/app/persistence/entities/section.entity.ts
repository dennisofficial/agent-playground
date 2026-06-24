import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * One SECTION of a job — a coherent slice (e.g. backend) that becomes a just-in-time phased plan.
 * Sections stack on the job's one feature branch and run sequentially (ORDER BY ordinal). `status` is
 * the explicit, resumable cursor. Gap-numbered ordinals so a re-plan can splice without renumbering.
 */
@Entity({ name: 'sections' })
@Index(['job_id'])
@Unique(['job_id', 'ordinal'])
export class SectionEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning job (FK → jobs). */
  @Column({ type: 'uuid' })
  job_id!: string;

  /** The tenant (Slack team id) — denormalized for team-scoped queries. */
  @Column({ type: 'text' })
  org_id!: string;

  /** Execution order within the job, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The one-line brief from the upfront section list. */
  @Column({ type: 'text' })
  brief!: string;

  /** The detailed just-in-time plan once generated; null while pending. Phases LOCK once planned. */
  @Column({ type: 'text', nullable: true })
  plan!: string | null;

  /** The prior section's handoff note threaded into this section's plan prompt. */
  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  /** This section's handoff note for the next section; null until done. */
  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;

  // 'pending' | 'planning' | 'reviewing' | 'awaiting_approval' | 'executing' | 'auto_fixing' | 'done' | 'failed'
  @Column({ type: 'text', default: 'pending' })
  status!: string;
}
