import { TimestampedEntity } from '@lib/database/base.entity';
import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn, Repository } from 'typeorm';
import { Repo } from '../../repo/entities/repo.entity';

/**
 * The Atlas-managed operational INSTRUCTIONS for a repo — one row per repo (PK = repoId). The scalar half
 * of the workspace profile: how Atlas arms the workspace (`setupScript`) and stands up a live preview
 * (`previewRecipe`). Mounts and secret files are the list halves, in their own child tables. Kept off the
 * hot `repos` row (companion-table convention, like `org_credentials`). `orgId` rides along for the
 * realtime guard scope. Verification is deliberately NOT modeled here (dropped this cycle).
 */
@Entity({ name: 'workspace_profiles' })
@Index(['orgId'])
export class WorkspaceProfile extends TimestampedEntity {
  /** One profile per repo — the repo IS the identity. */
  @PrimaryColumn({ type: 'uuid' })
  repoId!: string;

  @OneToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: Repo;

  @Column({ type: 'uuid' })
  orgId!: string;

  /** Cold-boot arming script the sandbox runs to make the workspace runnable. */
  @Column({ type: 'text', nullable: true })
  setupScript!: string | null;

  /** Recipe the agent follows to stand up a live preview (host exposes the port). */
  @Column({ type: 'text', nullable: true })
  previewRecipe!: string | null;
}

export class WorkspaceProfileRepo extends Repository<WorkspaceProfile> {}
