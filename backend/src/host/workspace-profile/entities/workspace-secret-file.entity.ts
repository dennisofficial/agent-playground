import { TimestampedEntity } from '@lib/database/base.entity';
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
 * A per-repo secret file (env / gitignored file) the sandbox writes into a job's container to make the repo
 * runnable. The `valueEnc` is AES-256-GCM at rest (via `SecretCipherService`) and WRITE-ONLY through the
 * API — reads/realtime expose `path` + `label` only, never ciphertext or plaintext. Unique per
 * `(repoId, path)`; `orgId` rides along for the realtime guard scope.
 */
@Entity({ name: 'workspace_secret_files' })
@Index(['orgId'])
@Index(['repoId', 'path'], { unique: true })
export class WorkspaceSecretFile extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @Column({ type: 'uuid' })
  repoId!: string;

  @ManyToOne(() => Repo, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: Repo;

  /** Destination path of the file in the workspace (e.g. `.env.local`). */
  @Column({ type: 'text' })
  path!: string;

  /** Optional human label for the operator UI. */
  @Column({ type: 'text', nullable: true })
  label!: string | null;

  /** Encrypted file contents (`iv.tag.ct`). Write-only — never returned by any read path. */
  @Column({ type: 'text' })
  valueEnc!: string;
}

export class WorkspaceSecretFileRepo extends Repository<WorkspaceSecretFile> {}
