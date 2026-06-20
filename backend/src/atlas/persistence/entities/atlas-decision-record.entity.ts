import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { Decision } from '../../domain/decision-record';

/**
 * The locked DECISION RECORD — the upfront grill's durable output: the agreed overview, the
 * architecture/system calls (`decisions`), and the high-level section list (`section_briefs`),
 * approved ONCE. It grounds every section's just-in-time plan and the decision-class gate (a section
 * planner parks only on an always-ask class NOT already settled here). Approved once, then immutable.
 */
@Entity({ name: 'atlas_decision_records' })
@Index(['team_id', 'project_id'])
@Index(['job_id'])
export class AtlasDecisionRecord extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id). */
  @Column({ type: 'text' })
  team_id!: string;

  /** The project this record scopes to. */
  @Column({ type: 'text' })
  project_id!: string;

  /** The job this record was produced for (FK → atlas_jobs). */
  @Column({ type: 'uuid' })
  job_id!: string;

  // 'draft' | 'approved' | 'superseded'
  @Column({ type: 'text', default: 'draft' })
  status!: string;

  /** The agreed overview — intent, stack, constraints, and how the sections fit together. */
  @Column({ type: 'text' })
  overview!: string;

  /** The locked architecture/system calls (a `Decision[]` from the domain types). */
  @Column({ type: 'jsonb', default: () => `'[]'::jsonb` })
  decisions!: Decision[];

  /** The high-level section briefs approved upfront — drives the job's section rows. */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  section_briefs!: string[];

  /** Who approved it (Dennis's id); null until approved. */
  @Column({ type: 'text', nullable: true })
  approved_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approved_at!: Date | null;
}
