import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { StageEntity } from './stage.entity';

/**
 * One row of a STAGE's shared task checklist (d6) — replaces BOTH of the old task blobs
 * (`threads.tasks` jsonb, the build-lane checklist; and `jobs.main_tasks` jsonb, the brain checklist).
 * Owned by the stage, not any single thread, so it survives builder-leg rotation (d1): any builder
 * thread in the stage reads/writes `tasks WHERE stage_id = X` and the next leg sees the full list and
 * keeps crediting it — no jsonb read-modify-write races. For a singleton stage (planning, etc.) the task
 * list is simply that one thread's checklist under its stage.
 *
 * The LLM tool surface (`TaskCreate`/`TaskUpdate`) is unchanged (thread 2/3) — handlers write rows keyed
 * to the active stage instead of mutating jsonb.
 */
@Entity({ name: 'tasks' })
@Index(['stage_id'])
@Index(['stage_id', 'ordinal'])
export class TaskEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning stage (FK → stages.id). */
  @Column({ type: 'uuid' })
  stage_id!: string;

  @ManyToOne(() => StageEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'stage_id' })
  stage?: StageEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Display/credit order within the stage, GAP-NUMBERED (10, 20, 30…). */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The task's short subject line. */
  @Column({ type: 'text' })
  title!: string;

  /** The task's longer description — shown under an in_progress task + as tooltip. Null when the
   *  authoring tool call didn't supply one. */
  @Column({ type: 'text', nullable: true })
  brief!: string | null;

  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to
   *  `title` when the authoring tool call didn't supply one (mirrors the old `TaskItem.activeForm`). */
  @Column({ type: 'text', nullable: true })
  active_form!: string | null;

  // 'pending' | 'in_progress' | 'completed' | 'dropped'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** Dependency edges — ids of OTHER rows in this same stage's checklist that this task waits on
   *  (mirrors the old `TaskItem.blockedBy`). A PENDING task with an incomplete blocker renders BLOCKED;
   *  the block clears by derivation when every blocker completes/drops. LITERAL default (a
   *  `() => '[]'::jsonb` function default makes `migration:generate` loop forever). */
  @Column({ type: 'jsonb', default: [] })
  blocked_by!: string[];
}
