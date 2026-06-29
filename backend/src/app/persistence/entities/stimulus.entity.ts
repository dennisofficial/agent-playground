import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { ThreadEntity } from './thread.entity';

/**
 * The durable record of an intake stimulus — both subtypes in one table, discriminated by `kind`:
 *  - 'chat'  — continues a thread (carries `thread_id` + author + reply route).
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
  thread_id!: string | null;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity | null;

  /** Chat author scope id; null for events. */
  @Column({ type: 'text', nullable: true })
  author_id!: string | null;

  /** Where Atlas replies to a chat stimulus (surface id + thread coordinate, JSON); null for events. */
  @Column({ type: 'jsonb', nullable: true })
  reply_route!: { surfaceId: string; threadRef: string } | null;

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
   * When this event was delivered to its thread's brain as a harness message (events only). Null until
   * the delivery turn completes — the at-least-once boot sweep re-delivers any seeded-but-undelivered
   * event so a crash between seed and the brain turn can't lose it. Chat rows never set it.
   */
  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;
}
