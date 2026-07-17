import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { JobEntity } from './job.entity';
import { ThreadEntity } from './thread.entity';
import { SubagentEntity } from './subagent.entity';

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
@Index(['stimulus_id'])
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
   *  - 'chat' (conversational, fed to the grill) | 'thinking' | 'tool' — transcript blocks (the brain AND
   *    build phases both write these via the shared transcript spine; phase blocks carry `meta.phaseId`).
   *  - 'card' — an approval/verdict/question card payload.
   *  - 'build_event' — a system pill (e.g. the Codex-review notice).
   *  - 'build_anchor' — the synthetic per-batch marker a build phase writes at start; the web renders it as
   *    the in-conversation "Build step" card that opens the step sub-page (carries `meta.phaseId`/label).
   */
  @Column({ type: 'text', default: 'chat' })
  kind!: string;

  /** Approval/verdict card payload (when kind='card'); null otherwise. */
  @Column({ type: 'jsonb', nullable: true })
  card!: Record<string, unknown> | null;

  /**
   * Opaque metadata: subagent/phase join keys (`parentToolUseId`, `id`, `phaseId`, `batchOrdinal`,
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

  /** The delivery-ledger row (`inbound_messages.id`) this transcript bubble was sent by — set only on an
   *  operator chat row so its send/delivery state correlates with the durable stimulus. Null on pills,
   *  seeds, and every non-operator row. */
  @Column({ type: 'uuid', nullable: true })
  stimulus_id!: string | null;

  /** When the SDK accepted the turn this bubble belongs to (the correlated stimulus was delivered). Null =
   *  still sending; set = landed. */
  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;

  /** Effective render-order instant — the moment the brain actually PROCESSED this row in its SDK
   *  conversation, when that differs from insert time. NULL for the common case (falls back to
   *  delivered_at, then created_at). Set only where render position must move off insert time — a
   *  pure-UI system notice posted while a turn was in flight, re-stamped at turn end to sit just after
   *  that turn's last block. created_at stays the truthful display time; delivered_at keeps its
   *  delivery-ledger meaning. */
  @Column({ type: 'timestamptz', nullable: true })
  order_at!: Date | null;
}
