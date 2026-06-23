import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { BranchingPolicy } from '../types/branching';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A registered project: binds the free-string project id that rooms/identity/worklog already carry
 * to a GitHub repo, so workspaces clone/push against the right remote per project. Unregistered
 * project ids keep the local-only clone behavior (no bound remote). `token_name` optionally overrides the
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

  /** One-line "what this project is" — the blurb Atlas sees in the reference-project catalog so it
   * knows the repo exists and what it's for before being asked. Null for projects registered before
   * this column / via the bare admin path. */
  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** HTTPS GitHub URL only (validated at the API edge); cloned to `<REPOS_ROOT>/<project_id>`. */
  @Column({ type: 'text' })
  git_url!: string;

  /** The PR base branch. */
  @Column({ type: 'text', default: 'main' })
  default_branch!: string;

  /** Per-project git branching policy (a `BranchingPolicy` from `@workspace/shared`): how a
   * workstation's branch name + base + upstream are derived from a `{kind, slug, ticket}` intent.
   * Null → `DEFAULT_BRANCHING_POLICY` (GitHub-flow that auto-detects dev/staging). */
  @Column({ type: 'jsonb', nullable: true })
  branching_policy!: BranchingPolicy | null;

  /** Named github_tokens override; null → the default token. */
  @Column({ type: 'text', nullable: true })
  token_name!: string | null;
}
