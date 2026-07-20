import { Injectable } from '@nestjs/common';
import type { EMountMode } from '@workspace/shared';
import { OrgService } from '../org/org.service';
import { RepoRepo } from '../repo/entities/repo.entity';
import { WorkspaceProfileRepo } from './entities/workspace-profile.entity';
import { MountService } from './mount.service';
import { SecretFileService } from './secret-file.service';

export interface WorkspaceMountView {
  path: string;
  mode: EMountMode;
}

export interface MaterializedSecretFile {
  path: string;
  label: string | null;
  value: string;
}

export interface WorkspaceProfileSnapshot {
  setupScript: string | null;
  previewRecipe: string | null;
  mounts: WorkspaceMountView[];
  secretFiles: { path: string; label: string | null }[];
}

/**
 * The workspace profile aggregate + instructions (setup script, preview recipe). Owns the scalar
 * `workspace_profiles` row and composes the mount/secret sub-services into a snapshot. Exported directly and
 * injected by consumers (SandboxModule etc.) — no port indirection; there's one implementation and no cycle.
 * SHELL this pass — method bodies land with the logic pass.
 */
@Injectable()
export class WorkspaceProfileService {
  constructor(
    private readonly profiles: WorkspaceProfileRepo,
    private readonly repos: RepoRepo,
    private readonly orgs: OrgService,
    private readonly mounts: MountService,
    private readonly secrets: SecretFileService,
  ) {}

  /** Read-only aggregate of the repo's workspace profile (safe fields only). */
  describe(_orgId: string, _repoId: string): Promise<WorkspaceProfileSnapshot> {
    throw new Error('not implemented');
  }

  /** Mounts to materialize into a container. Internal (host provisioning), no tenancy check. */
  materializeMounts(_repoId: string): Promise<WorkspaceMountView[]> {
    throw new Error('not implemented');
  }

  /** Secret files WITH decrypted contents to write into a container. Internal, no tenancy check. */
  materializeSecrets(_repoId: string): Promise<MaterializedSecretFile[]> {
    throw new Error('not implemented');
  }
}
