import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * The durable record of an intake stimulus — both subtypes in one table, discriminated by `kind`:
 *  - 'chat'  — continues a thread (carries `thread_id` + author + reply route).
 *  - 'event' — opens a new thread; UNTRUSTED; carries `source`, `dedupe_key`, `severity`. The
 *    mechanical pre-harness filter dedups by `dedupe_key` (events only) so the firehose doesn't pay
 *    an Atlas turn per duplicate.
 */
@Entity({ name: 'atlas_stimuli' })
@Index(['team_id', 'project_id'])
// Event dedup: at most one live event row per (team, project, source, dedupe_key). Partial — chat
// stimuli carry no dedupe_key and are exempt.
@Index(['team_id', 'project_id', 'source', 'dedupe_key'], {
  unique: true,
  where: `"kind" = 'event'`,
})
export class AtlasStimulus extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id). */
  @Column({ type: 'text' })
  team_id!: string;

  /** The project (and thus channel) this stimulus routes to. */
  @Column({ type: 'text' })
  project_id!: string;

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
}
