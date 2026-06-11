import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A registered project: binds the free-string project id that rooms/identity/worklog already carry
 * to a GitHub repo, so worktrees clone/push against the right remote per project. Unregistered
 * project ids keep the local-only WORKER_ROOT behavior. `token_name` optionally overrides the
 * default GitHub token (no TypeORM relation — house style is raw SQL; delete-integrity lives in
 * the token store).
 */
@Entity({ name: 'projects' })
export class Project extends TimestampedEntity {
  /** The tenant (Slack team id) this project belongs to — part of the PK so two workspaces can
   * each register a project with the same slug. */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  /** The project slug rooms use (`ChannelInfo.project` / `Identity.project`). */
  @PrimaryColumn({ type: 'text' })
  project_id!: string;

  @Column({ type: 'text' })
  display_name!: string;

  /** HTTPS GitHub URL only (validated at the API edge); cloned to `<REPOS_ROOT>/<project_id>`. */
  @Column({ type: 'text' })
  git_url!: string;

  /** The PR base branch. */
  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  /** Named github_tokens override; null → the default token. */
  @Column({ type: 'text', nullable: true })
  token_name!: string | null;
}
