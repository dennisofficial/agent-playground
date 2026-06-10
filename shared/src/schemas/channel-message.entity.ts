import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * One message in a chat surface's append-only channel log — the durable chat history. `seq` is the
 * monotonic cursor coordinate per surface (a bot tracks consumption as `deliveredUpTo` in
 * `bot_cursors`). The id is the surface-stable message id — surface-native when the surface has one
 * (a Slack ts), minted otherwise — and is unique only PER SURFACE, so identity is the composite
 * (surface_id, id). A message re-emitted with the same identity is an in-place update (streaming
 * edits), hence not (surface, seq).
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
  @PrimaryColumn({ type: 'text' })
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
