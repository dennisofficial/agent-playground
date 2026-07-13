import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { JobEntity } from './job.entity';
import { DecisionRecordEntity } from './decision-record.entity';

/**
 * A STAGE — the first-class §N pipeline grouping (d2/d7). A job's pipeline is the ordinal-ordered
 * sequence of its stages: `planning | plan_review | build | direct_build | master_review | post_build |
 * ci`. EVERY thread belongs to exactly one stage (`threads.stage_id` NOT NULL) — there is no job-level
 * ungrouped thread, so even a pure-chat job has exactly one `planning` stage.
 *
 * A `build`/`direct_build` stage owns MULTIPLE threads (sequential builder legs + review_agent(s) +
 * review_fix, per d1) plus the stage's shared `tasks` checklist; every other kind is a singleton stage
 * (one thread). Behavior per kind (which roles it contains, whether it reviews, when it spawns) lives in
 * the stage-kind registry in code (thread 2), not on this row (d8) — this table is typed state + the
 * ordinal grouping only.
 *
 * `ordinal` is GAP-NUMBERED and the pipeline is APPEND-ONLY across re-plan rounds (d7): a big amendment
 * appends a fresh `planning`→…→`post_build`/`ci` run after the prior stages, which stay as visible
 * history rather than being deleted or renumbered.
 */
@Entity({ name: 'stages' })
@Index(['job_id'])
@Index(['job_id', 'ordinal'])
export class StageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning job (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Position in the job's append-only pipeline, GAP-NUMBERED (10, 20, 30…) so a re-plan round can
   *  splice/append without renumbering earlier stages. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The stage KIND — `planning | plan_review | build | direct_build | master_review | post_build | ci`.
   *  The single differentiator; behavior lives in the stage-kind registry (thread 2), not here (d8). No
   *  column default — every write site sets it explicitly. Stays `text` (no DB enum) — the app layer
   *  validates via `coerceStageKind` (thread 2). */
  @Column({ type: 'text' })
  kind!: string;

  /** Human label — NULLABLE, populated only for `build`/`direct_build` stages (the slice name, e.g.
   *  "Foundation") and `planning` stages (to disambiguate re-plan rounds, e.g. "Re-plan #2"). Other kinds
   *  derive their sidebar label from `kind` alone. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The build slice's review-selection TYPE (moved off `threads.type`, d7) — the deterministic routing
   *  key for review-agent selection (`backend | frontend | docs | testing | infra | data | general`).
   *  Nullable — only meaningful for `build`/`direct_build` stages. Stays `text` (app-layer validated). */
  @Column({ type: 'text', nullable: true })
  type!: string | null;

  // 'pending' | 'planning' | 'reviewing' | 'executing' | 'auto_fixing' | 'done' — the pure linear step.
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  // 'none' | 'paused' | 'incomplete' | 'failed' | 'skipped' — the orthogonal condition overlay.
  @Column({ type: 'text', default: 'none' })
  condition!: string;

  /**
   * The PLAN REVISION this stage belongs to (FK → decision_records.id) — moved here from `threads` (d7):
   * plan-revision scoping is now a stage-level concern. A re-propose over already-done work creates a new
   * revision and appends fresh stages under it; prior-revision stages keep their record id and stay
   * immutable, browsable history. Null for revision-agnostic/legacy stages. `onDelete: CASCADE` so pruning
   * a never-built draft record clears its stages.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  /**
   * Kind-specific PARAMS (d8) — e.g. a `build` stage's diff range hints, a `plan_review` stage's spec
   * hash. Promote a field to a real typed column only when it must be queried/indexed/FK'd. PLAIN-LITERAL
   * default (a `() => '{}'::jsonb` function default makes `migration:generate` loop forever).
   */
  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;
}
