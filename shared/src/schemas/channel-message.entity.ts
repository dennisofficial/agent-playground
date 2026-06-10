import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * One message in a chat surface's append-only channel log — the durable chat history. `seq` is the
 * monotonic cursor coordinate per surface (a bot tracks consumption as `deliveredUpTo` in
 * `bot_cursors`). The id is the surface-stable message id ('u-0', 'alex:12'); a message re-emitted
 * with the same id is an in-place update (streaming edits), hence id — not (surface, seq) — is the
 * primary key.
 */
@Entity({ name: 'channel_messages' })
@Index(['surface_id', 'seq'], { unique: true })
export class ChannelMessage extends TimestampedEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  // bigint → string through the pg driver; the ChannelService converts to number at the boundary.
  @Column({ type: 'bigint' })
  seq!: string;

  /** Channel/thread coordinate, e.g. 'tui:main' | 'slack:C042:1712.5678'. */
  @Column({ type: 'text' })
  surface_id!: string;

  /** Display name ("Dennis", "Alex"). */
  @Column({ type: 'text' })
  author!: string;

  /** Scope id ("dennis", "alex"). */
  @Column({ type: 'text' })
  author_id!: string;

  /** Set when a bot authored it. */
  @Column({ type: 'text', nullable: true })
  author_bot_id!: string | null;

  @Column({ type: 'text' })
  text!: string;
}
