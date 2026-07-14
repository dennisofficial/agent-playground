import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { JobEntity } from './job.entity';

/**
 * One message in a thread's append-only log. Many histories = ONE `messages` table partitioned
 * by `job_id` (the index below). Threads are isolated; coherence across them is shared memory, not
 * shared transcript.
 */
@Entity({ name: 'messages' })
@Index(['job_id', 'created_at'])
@Index('ux_messages_idem_key', ['idem_key'], { unique: true, where: `"idem_key" IS NOT NULL` })
export class MessageEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The thread this message belongs to — the partition key (FK → threads). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

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
   * `batchStepIds`), tool `{name,input,result,isError}`, or message provenance (`source`); null otherwise.
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
