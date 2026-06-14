import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Thread-local structured note — the per-bot scratchpad for the current channel/DM thread.
 * Kinds: todo (concrete next step), hypothesis (assumption worth tracking), blocker (something
 * stopping progress), handoff (context a future bot/session needs). Resolved notes are kept for
 * the thread record but drop out of the assembler's context slot.
 *
 * Scoped to (team_id, owner_bot, channel_id) — one bot's notes for one thread, never shared
 * across bots or surfaces. Session-local: not global semantic memory.
 */
@Entity({ name: 'session_notes' })
@Index(['team_id', 'owner_bot', 'channel_id', 'status'])
export class SessionNote extends TimestampedEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  owner_bot!: string;

  /** The surface/thread id — `identity.surface`. Defines the "session" scope. */
  @Column({ type: 'text' })
  channel_id!: string;

  @Column({ type: 'text' })
  project!: string;

  /** todo | hypothesis | blocker | handoff */
  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  body!: string;

  /** open | resolved */
  @Column({ type: 'text', default: 'open' })
  status!: string;
}
