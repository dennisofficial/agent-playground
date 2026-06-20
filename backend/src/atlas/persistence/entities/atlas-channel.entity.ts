import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * The channel — ONE per project (1:1 with `atlas_projects`). Notifications route to the project's
 * channel; decision-records and memory scope to it; for one-repo tenants it collapses to a single
 * channel. Threads (`atlas_threads`) hang off a channel. Namespaced `atlas_channels` so it stands
 * alongside v1's live `channels` table.
 */
@Entity({ name: 'atlas_channels' })
@Index(['team_id'])
@Unique(['team_id', 'project_id']) // 1:1 with the project
export class AtlasChannel extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id) that owns this channel (FK → atlas_teams). */
  @Column({ type: 'text' })
  team_id!: string;

  /** The project this channel is 1:1 with (FK → atlas_projects(team_id, project_id)). */
  @Column({ type: 'text' })
  project_id!: string;

  /** The surface-native channel coordinate (e.g. a Slack channel id 'C042'); null until bound. */
  @Column({ type: 'text', nullable: true })
  surface_channel_ref!: string | null;

  @Column({ type: 'text' })
  display_name!: string;
}
