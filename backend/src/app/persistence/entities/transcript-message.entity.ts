import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { JobEntity } from './job.entity';
import { SubagentEntity } from './subagent.entity';
import { ThreadEntity } from './thread.entity';

/**
 * One message in a thread's append-only log. `thread_id` is the real partition key (d3) — every message
 * belongs to exactly one thread, and a job's conversation log is the UNION of its threads' messages.
 * `job_id` stays denormalized for job-wide queries. Rendering is uniform via "messages for this node": a
 * node is either a thread (`subagent_id IS NULL`) or a subagent (`subagent_id = X`, d4).
 */
@Entity({ name: 'transcript_messages' })
@Index(['job_id', 'created_at'])
@Index(['thread_id', 'created_at'])
@Index(['subagent_id'])
@Index('ux_transcript_messages_idem_key', ['idem_key'], {
  unique: true,
  where: `"idem_key" IS NOT NULL`,
})
export class TranscriptMessageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning job — denormalized for job-wide queries (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /** The thread this message belongs to — the real partition key (FK → threads.id, d3). NOT NULL after
   *  the migration's backfill. */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  threadRef?: ThreadEntity;

  /** The subagent this message belongs to, when it's a subagent transcript block; null for a plain
   *  thread-level message (FK → subagents.id, d4). */
  @Column({ type: 'uuid', nullable: true })
  subagent_id!: string | null;

  @ManyToOne(() => SubagentEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'subagent_id' })
  subagent?: SubagentEntity | null;

  /** Display name ("Dennis", "Atlas"). */
  @Column({ type: 'text' })
  author!: string;

  /** Scope id ("dennis", "atlas"). */
  @Column({ type: 'text' })
  author_id!: string;

  /** Set when Atlas (the brain) authored it. */
  @Column({ type: 'text', nullable: true })
  author_bot_id!: string | null;

  @Column({ type: 'text' })
  text!: string;

  /** Surface ordering handle (the synthetic ts the surface minted); also the SSE/edit key. */
  @Column({ type: 'text', nullable: true })
  ts!: string | null;

  /**
   * What this row is:
   *  - 'chat' (conversational, fed to the grill) | 'thinking' | 'tool' — transcript blocks (the conversational
   *    sessions AND build turns (Legs) both write these via the shared transcript spine; every row is anchored
   *    by `thread_id`, and a build turn's blocks additionally carry the legacy `meta.phaseId` join key).
   *  - 'card' — an approval/verdict/question card payload.
   *  - 'build_event' — a system pill (e.g. the Codex-review notice).
   *  - 'build_anchor' — the synthetic per-batch marker a build turn (Leg) writes at start; the web renders it as
   *    the in-conversation "Build step" card that opens the step sub-page (carries `meta.phaseId`/label).
   */
  @Column({ type: 'text', default: 'chat' })
  kind!: string;

  /** Approval/verdict card payload (when kind='card'); null otherwise. */
  @Column({ type: 'jsonb', nullable: true })
  card!: Record<string, unknown> | null;

  /**
   * Opaque metadata: subagent/build-turn join keys (`parentToolUseId`, `id`, `phaseId`, `batchOrdinal`,
   * `batchStepIds`), tool `{name,input,result,isError}`, or message provenance (`source`); null otherwise. A
   * `system_operator` box also carries `retryable`/`sessionLimit`/`resumeAt` plus, additively, a
   * `TurnFailureCategory` `category` (`'session_limit'|'auth'|'transient'|'api_overloaded'|'sandbox_lost'|
   * 'unresumable'|'unknown'`) and a friendly one-line `summary` — see `turn-failure-summary.ts`.
   */
  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;

  /**
   * Stable per-block identity `${turn_id}:${ordinal}` for idempotent (re)persist of a brain transcript
   * block; null for rows written without a turn context (legacy rows, non-turn writers). Deduped by the
   * partial unique index `ux_messages_idem_key` (WHERE idem_key IS NOT NULL) so two racing finishers of the
   * same turn upsert into one row instead of duplicating.
   */
  @Column({ type: 'text', nullable: true })
  idem_key!: string | null;

  /** Git commit of the backend process that wrote this transcript row (auto-stamped). */
  @Column({ type: 'text', nullable: true })
  engine_git_sha!: string | null;
}
