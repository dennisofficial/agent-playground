import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { JobEntity } from './job.entity';
import { numberColumn } from './numeric.transformer';

/**
 * One row per completed engine turn that reported usage — the durable, queryable per-turn analytics
 * record (formerly only a transient `messages(kind='turn_meta')` block whose per-model detail was
 * dropped). Written by `TurnUsageProjector` at each turn-completion site. Per-model breakdown lives in
 * the child `turn_model_usage` rows; the SDK's raw `modelUsage` map is preserved in `raw` so any future
 * metric is re-derivable without re-running jobs.
 *
 * `created_at` (from the base) ≈ turn-END time; there is no reliable turn-START at the completion site,
 * so no duration column for now.
 */
@Entity({ name: 'turn_stats' })
@Index(['job_id'])
@Index(['org_id'])
@Index(['thread_id'])
export class TurnStatsEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The engine turn id (Redis `turn:{id}:*` namespace) when the caller has it; null for fresh turns
   *  whose id is minted inside the runner and not returned to the completion site. Correlation is by
   *  job_id/lane/created_at when absent. */
  @Column({ type: 'uuid', nullable: true })
  turn_id!: string | null;

  /** The tenant (denormalized for org-scoped queries; FK → organizations via job). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /** The owning job/container (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The build lane/thread this turn ran on (parsed from lane `thread:<id>`); null for the brain (`main`). */
  @Column({ type: 'uuid', nullable: true })
  thread_id!: string | null;

  /** The build step this turn advanced (= `metaTag.phaseId`); null for non-build turns. */
  @Column({ type: 'uuid', nullable: true })
  step_id!: string | null;

  /** Transcript lane: 'main' | 'thread:<threadId>' | 'phase:<stepId>' | 'codex-review:<jobId>'. */
  @Column({ type: 'text' })
  lane!: string;

  /** The turn's role — the PHASE dimension: 'brain' | 'step' | 'review' | 'gate' | 'autofix' | 'compaction'. */
  @Column({ type: 'text' })
  kind!: string;

  /** Which engine ran the turn: 'claude' | 'codex'. */
  @Column({ type: 'text' })
  engine!: string;

  /** The claude_credentials.id that authed this turn; NULL for Codex / non-agentic (d3). */
  @Column({ type: 'uuid', nullable: true })
  credential_id!: string | null;

  /** Git commit of the backend process that wrote this row (AppVersionService.sha; "dev" locally). */
  @Column({ type: 'text', nullable: true })
  engine_git_sha!: string | null;

  /** The primary (orchestrator) model id the turn reported; null when the engine surfaced none. */
  @Column({ type: 'text', nullable: true })
  model!: string | null;

  /** Turn totals (SUMMED across every round-trip; input is cache-inclusive — the billing shape). */
  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  input_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  output_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_read_tokens!: number;

  @Column({ type: 'bigint', default: 0, transformer: numberColumn })
  cache_write_tokens!: number;

  /** SDK-computed total cost for the turn (`total_cost_usd`); null for Codex (priced server-side). */
  @Column({ type: 'numeric', nullable: true, transformer: numberColumn })
  cost_usd!: number | null;

  /** Context-window occupancy proxy (main agent's last round-trip input) + the window size. */
  @Column({ type: 'int', nullable: true })
  context_tokens!: number | null;

  @Column({ type: 'int', nullable: true })
  context_limit!: number | null;

  /** Secondary attribution the lane/kind don't carry: batchOrdinal / autofixId / lensId / fixTurn / scope. */
  @Column({ type: 'jsonb', nullable: true })
  tags!: Record<string, unknown> | null;

  /** The SDK usage envelope kept verbatim (modelUsage map + flat usage + total_cost_usd) — the raw
   *  source of truth so a new metric can be re-derived without re-running the job. */
  @Column({ type: 'jsonb', nullable: true })
  raw!: Record<string, unknown> | null;
}
