import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A tenant = a Slack workspace (the `team_id` dimension). Atlas v2's own registry row, namespaced
 * `atlas_teams` so it stands alongside v1's live `tenants` table without colliding. Every
 * tenant-scoped `atlas_*` table carries the same `team_id`.
 */
@Entity({ name: 'atlas_teams' })
export class AtlasTeam extends TimestampedEntity {
  /** The Slack team id — THE tenant id everywhere in Atlas v2. */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @Column({ type: 'text' })
  team_name!: string;

  @Column({ type: 'text', default: 'active' })
  status!: string; // 'active' | 'suspended'
}
