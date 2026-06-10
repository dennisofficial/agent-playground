import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * The channel registry — one row per conversation room (group chat, DM, group DM). The channel id
 * is the surface coordinate messages carry ('tui:main' | 'slack:C042'); `project` maps the room to
 * its memory scope; `members` are the participant ids (bot ids + human ids) that routing/scheduling
 * iterate over. Rooms register here on creation (TUI `/room`, Slack invite) or lazily on first
 * message.
 */
@Entity({ name: 'channels' })
export class Channel extends TimestampedEntity {
  @PrimaryColumn({ type: 'text' })
  channel_id!: string;

  /** 'channel' | 'dm' | 'group-dm' — drives identity.isChannel (pair-scope memory) + gate rules. */
  @Column({ type: 'text' })
  kind!: string;

  /** The project/workspace this room belongs to — the memory `project:` tier facts distill into. */
  @Column({ type: 'text' })
  project!: string;

  /** Participant ids — bot ids and human ids alike ('alex', 'dennis'). */
  @Column({ type: 'text', array: true, default: () => `'{}'` })
  members!: string[];

  @Column({ type: 'text' })
  display_name!: string;
}
