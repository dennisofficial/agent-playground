import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';

/**
 * A THREAD — the unit of work. One intent (a feature or a bugfix) = one sandbox = one worktree = one
 * feature branch = ONE PR. A thread may stay a plain conversation (`status='open'`) or enter the build
 * lifecycle; when it builds, the `sections`/`phases` rows hang directly off it (the former `jobs` layer
 * is folded in here). `decision_records` (1:many — the draft→superseded proposal trail) reference it.
 * `messages` partition by `thread_id`. Threads are isolated for context hygiene — cross-thread coherence
 * is shared memory only, never transcript sharing.
 *
 * `status` (build lifecycle) is a SEPARATE axis from `thread_sandboxes.lifecycle` (container/worktree
 * infra). The branch + PR live HERE (single owner); the sandbox is the disposable workspace.
 */
@Entity({ name: 'threads' })
@Index(['org_id', 'repo_id'])
export class ThreadEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this thread builds against (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** What opened the thread: 'chat' | 'event' | 'control' (operator-created). */
  @Column({ type: 'text' })
  origin!: string;

  /** The surface-native thread coordinate (e.g. the root message ts); null until posted. */
  @Column({ type: 'text', nullable: true })
  surface_thread_ref!: string | null;

  /** Short human-readable label (the feature/notification title). */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The base branch the build cuts from (operator-picked; null → the repo's default_branch). */
  @Column({ type: 'text', nullable: true })
  base_branch!: string | null;

  // ── build lifecycle (folded in from the former `jobs` table) ───────────────────────────────────────
  /** Build intent: 'feature' (many sections) | 'bugfix' (one). Null until the thread is scoped. */
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  // 'open' | 'scoping' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  @Column({ type: 'text', default: 'open' })
  status!: string;

  /** The locked decision record (FK → decision_records.id); null until the upfront grill produces one. */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  /** The feature branch all sections stack on; null until the branch is cut. */
  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  /** The opened PR url; null until the PR-tail stage opens one. */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;

  /** The opened PR number — what the merge poll queries GitHub with; null until opened. */
  @Column({ type: 'int', nullable: true })
  pr_number!: number | null;
}
