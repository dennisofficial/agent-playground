import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { DecisionRecordEntity } from './decision-record.entity';
import { JobEntity } from './job.entity';
import { OrganizationEntity } from './organization.entity';

/**
 * A THREAD GROUP — the first-class §N pipeline grouping (d2/d7). A job's pipeline is the ordinal-ordered
 * sequence of its thread groups: `planning | section | master_review | post_build | ship`. EVERY thread
 * belongs to exactly one thread group (`threads.thread_group_id` NOT NULL) — there is no job-level
 * ungrouped thread, so even a pure-chat job has exactly one `planning` thread group.
 *
 * A `section` thread group owns MULTIPLE threads (sequential builder legs + review_agent(s) +
 * review_fix, per d1) plus the thread group's shared `tasks` checklist; every other kind is a singleton
 * thread group (one thread). Behavior per kind (which roles it contains, whether it reviews, when it
 * spawns) lives in the thread-group-kind registry in code (thread 2), not on this row (d8) — this table is
 * typed state + the ordinal grouping only.
 *
 * `ordinal` is GAP-NUMBERED and the pipeline is APPEND-ONLY across re-plan rounds (d7): a big amendment
 * appends a fresh `planning`→…→`post_build`/`ship` run after the prior thread groups, which stay as visible
 * history rather than being deleted or renumbered.
 */
@Entity({ name: 'thread_groups' })
@Index(['job_id'])
@Index(['job_id', 'ordinal'])
export class ThreadGroupEntity extends TimestampedEntity {
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
   *  splice/append without renumbering earlier thread groups. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The thread-group KIND — `planning | section | master_review | post_build | ship`. The single
   *  differentiator; behavior lives in the thread-group-kind registry (thread 2), not here (d8). No column
   *  default — every write site sets it explicitly. Stays `text` (no DB enum) — the app layer validates via
   *  `coerceThreadGroupKind` (thread 2). */
  @Column({ type: 'text' })
  kind!: string;

  /** Human label — NULLABLE, populated only for `section` thread groups (the slice name, e.g.
   *  "Foundation") and `planning` thread groups (to disambiguate re-plan rounds, e.g. "Re-plan #2"). Other
   *  kinds derive their sidebar label from `kind` alone. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The build slice's review-selection TYPE (moved off `threads.type`, d7) — the deterministic routing
   *  key for review-agent selection (`backend | frontend | docs | testing | infra | data | general`).
   *  Nullable — only meaningful for `section` thread groups. Stays `text` (app-layer validated). */
  @Column({ type: 'text', nullable: true })
  type!: string | null;

  // 'pending' | 'active' | 'done' — the pure linear step (scheduler-maintained).
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /**
   * The PLAN REVISION this thread group belongs to (FK → decision_records.id) — moved here from `threads`
   * (d7): plan-revision scoping is now a thread-group-level concern. A re-propose over already-done work
   * creates a new revision and appends fresh thread groups under it; prior-revision thread groups keep
   * their record id and stay immutable, browsable history. Null for revision-agnostic/legacy thread
   * groups. `onDelete: CASCADE` so pruning a never-built draft record clears its thread groups.
   */
  @Column({ type: 'uuid', nullable: true })
  @Index()
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  /**
   * Kind-specific PARAMS (d8) — e.g. a `section` thread group's diff range hints, a `planning` thread
   * group's spec hash. Promote a field to a real typed column only when it must be queried/indexed/FK'd.
   * PLAIN-LITERAL default (a `() => '{}'::jsonb` function default makes `migration:generate` loop forever).
   */
  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;
}
