import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * The channel registry — one row per conversation room (group chat, DM, group DM). The channel id
 * is the surface coordinate messages carry, tenant-qualified ('tui:main' | 'slack:T042:C042') so
 * it is globally unique across workspaces; `team_id` is the owning tenant; `project` maps the room
 * to its memory scope; `members` are the participant ids (bot ids + human ids) that routing/
 * scheduling iterate over. Rooms register here on creation (TUI `/room`, Slack invite) or lazily on
 * first message.
 */
@Entity({ name: 'channels' })
@Index(['team_id'])
export class Channel extends TimestampedEntity {
  @PrimaryColumn({ type: 'text' })
  channel_id!: string;

  /** The tenant (Slack team id) that owns this room. */
  @Column({ type: 'text' })
  team_id!: string;

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
