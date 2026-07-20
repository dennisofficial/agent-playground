import { TimestampedEntity } from '@lib/database/base.entity';
import { EMountMode } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { Repo } from '../../repo/entities/repo.entity';

/**
 * A per-repo mount the sandbox materializes into a job's container. The list half of the workspace profile.
 * Unique per `(repoId, path)`; `orgId` rides along for the realtime guard scope. Storage/management only —
 * the future SandboxModule reads these via `WORKSPACE_PROFILE_PORT` to actually mount them.
 */
@Entity({ name: 'workspace_mounts' })
@Index(['orgId'])
@Index(['repoId', 'path'], { unique: true })
export class WorkspaceMount extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @Column({ type: 'uuid' })
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: Repo;

  /** In-workspace mount path. */
  @Column({ type: 'text' })
  path!: string;

  @Column({ type: 'enum', enum: EMountMode, default: EMountMode.PER_THREAD })
  mode!: EMountMode;
}

export class WorkspaceMountRepo extends Repository<WorkspaceMount> {}
