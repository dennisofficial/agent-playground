import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { SectionEntity } from './section.entity';
import { ThreadEntity } from './thread.entity';

/**
 * One PHASE of a section's locked plan — runs as a FRESH session on the feature branch (fresh context
 * per phase keeps the window <300k and avoids hallucination; the shared checkout lets later phases
 * build on earlier code). `step` + `status` are the EXPLICIT, resumable cursor — the deterministic
 * driver re-enters here on restart rather than re-deriving control flow from statuses. Strictly
 * sequential within a section; gap-numbered.
 */
@Entity({ name: 'phases' })
@Index(['section_id'])
@Index(['thread_id'])
@Unique(['section_id', 'ordinal'])
export class PhaseEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning section (FK → sections.id). */
  @Column({ type: 'uuid' })
  section_id!: string;

  @ManyToOne(() => SectionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'section_id' })
  section?: SectionEntity;

  /** The owning thread (denormalized for thread-scoped boot recovery; FK → threads.id). */
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

  /**
   * Which execution BATCH this phase belongs to within its section. A fresh-context step packs the
   * ordered phases into consecutive groups; every phase in one group runs in ONE engine session. Null
   * until the section first executes; assigned + persisted then so a resumed/restarted section
   * re-groups IDENTICALLY — the resume cursor keys off the group's anchor phase `session_id`, so batch
   * membership MUST be stable across a restart (a re-batch would hand a resumed session the wrong task).
   */
  @Column({ type: 'int', nullable: true })
  batch_ordinal!: number | null;
}
