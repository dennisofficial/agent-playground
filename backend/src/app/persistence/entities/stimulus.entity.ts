import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';

/**
 * The durable record of an intake stimulus — both subtypes in one table, discriminated by `kind`:
 *  - 'chat'  — continues a thread (carries `job_id` + author + reply route).
 *  - 'event' — opens a new thread; UNTRUSTED; carries `source`, `dedupe_key`, `severity`. The
 *    mechanical pre-harness filter dedups by `dedupe_key` (events only) so the firehose doesn't pay
 *    an Atlas turn per duplicate.
 */
@Entity({ name: 'stimuli' })
@Index(['org_id', 'repo_id'])
// Event dedup: at most one live event row per (team, project, source, dedupe_key). Partial — chat
// stimuli carry no dedupe_key and are exempt.
@Index(['org_id', 'repo_id', 'source', 'dedupe_key'], {
  unique: true,
  where: `"kind" = 'event'`,
})
export class StimulusEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (org id; FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this stimulus routes to (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** Subtype discriminator: 'chat' | 'event'. */
  @Column({ type: 'text' })
  kind!: string;

  /** Trust label: 'trusted' (chat) | 'untrusted' (every event body is data, never instructions). */
  @Column({ type: 'text' })
  trust!: string;

  /** The raw text/body Atlas triages. */
  @Column({ type: 'text' })
  body!: string;

  // ─── chat-only ──────────────────────────────────────────────────────────
  /** The thread a chat stimulus continues (null for events, which OPEN a thread). */
  @Column({ type: 'uuid', nullable: true })
  job_id!: string | null;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity | null;

  /** Routing coordinate within `job_id`: `'main'` (brain) or `'thread:<threadId>'` (a build lane). Mirrors
   *  `ActiveTurnEntity.lane`. Defaults `'main'` so pre-existing rows (and brain callers, which never set it)
   *  route unchanged. */
  @Column({ type: 'text', default: 'main' })
  lane!: string;

  /** Chat author scope id; null for events. */
  @Column({ type: 'text', nullable: true })
  author_id!: string | null;

  /**
   * Chat author display name; null for events (and for chat rows written before this column existed —
   * the durable delivery pump then falls back to `author_id` as the label). Persisted so the pump can
   * reconstruct a full `ChatStimulus` from the row alone when re-driving an undelivered message.
   */
  @Column({ type: 'text', nullable: true })
  author_name!: string | null;

  /**
   * Where Atlas replies to a chat stimulus (surface id + thread coordinate, JSON); null for events. Also
   * carries the optional delivery `priority` (d18: `now` | `queue` | `later`) — piggybacked in this jsonb
   * (via `->> 'priority'`) rather than a new column, since it's opportunistic metadata, not a FK/index target.
   */
  @Column({ type: 'jsonb', nullable: true })
  reply_route!: { surfaceId: string; jobRef: string; priority?: 'now' | 'queue' | 'later' } | null;

  // ─── event-only ─────────────────────────────────────────────────────────
  /** The gateway that produced an event, e.g. 'github' | 'webhook'; null for chat. */
  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** Collapse key for the mechanical dedup/rate-limit filter (events only). */
  @Column({ type: 'text', nullable: true })
  dedupe_key!: string | null;

  /** Severity the adapter mapped: 'info' | 'warning' | 'critical' (events only). */
  @Column({ type: 'text', nullable: true })
  severity!: string | null;

  /**
   * When this stimulus was delivered to its thread's brain (both subtypes now). For an EVENT: null until
   * the delivery turn completes. For CHAT: null until the message was positively TAKEN — handed to a
   * restart-survivable engine turn (stamped from the runner's `onTurnRegistered` hand-off) or steered
   * with an engine `input_ack`. The at-least-once boot + periodic sweep re-drives any still-null row so a
   * crash / sandbox transition / swallowed steer can't lose it.
   */
  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;

  /**
   * DELIVERY LEASE (chat only). Set to `now()` the instant the delivery pump takes a pending row (steers
   * it or hands it to a fresh turn), so the same message can't be re-selected — and re-steered — within
   * the loop or by a concurrent sweep. A row is eligible again only when `delivered_at IS NULL AND
   * (attempted_at IS NULL OR attempted_at < now() - lease)`, so a genuinely lost hand-off re-drives once
   * the lease expires. Null = never attempted.
   */
  @Column({ type: 'timestamptz', nullable: true })
  attempted_at!: Date | null;
}
