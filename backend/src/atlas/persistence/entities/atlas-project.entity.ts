import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * A registered project = a GitHub repo Atlas v2 works against. Tenant (`team_id`) ⊃ projects; one
 * channel per project (`atlas_channels`, 1:1). Namespaced `atlas_projects` so it stands alongside
 * v1's live `projects` table. The composite PK (team_id, project_id) lets two workspaces each
 * register the same slug.
 */
@Entity({ name: 'atlas_projects' })
@Index(['team_id'])
export class AtlasProject extends TimestampedEntity {
  /** The tenant (Slack team id) this project belongs to (FK → atlas_teams). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  /** The project slug threads/jobs/memory scope to. */
  @PrimaryColumn({ type: 'text' })
  project_id!: string;

  @Column({ type: 'text' })
  display_name!: string;

  /** One-line "what this project is". */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** HTTPS GitHub URL — cloned locally for the per-feature worktree sandboxes (MVP host-only). */
  @Column({ type: 'text' })
  git_url!: string;

  /** The PR base branch. */
  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  /** Named GitHub-token override; null → the default token (the rewritten PR client resolves it). */
  @Column({ type: 'text', nullable: true })
  token_name!: string | null;
}
