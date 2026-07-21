import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { Injectable } from '@nestjs/common';
import type { EMountMode } from '@workspace/shared';
import { WorkspaceMountRepo } from '../../_lib/database/entities/workspace-mount.entity';
import { WorkspaceProfileRepo } from '../../_lib/database/entities/workspace-profile.entity';
import { WorkspaceSecretFileRepo } from '../../_lib/database/entities/workspace-secret-file.entity';

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

@Injectable()
export class WorkspaceProfileService {
  constructor(
    private readonly workspaceProfileRepo: WorkspaceProfileRepo,
    private readonly workspaceMountRepo: WorkspaceMountRepo,
    private readonly workspaceSecretFileRepo: WorkspaceSecretFileRepo,
    private readonly secretCipherService: SecretCipherService,
  ) {}

  /** Read-only aggregate of the repo's workspace profile (safe fields only). */
  describe(_orgId: string, _repoId: string): Promise<WorkspaceProfileSnapshot> {
    throw new Error('not implemented');
  }

  /** The cold-boot setup script the sandbox runs on first provision. Internal, no tenancy check. */
  async materializeSetupScript(repoId: string): Promise<string | null> {
    const profile = await this.workspaceProfileRepo.findOne({ where: { repoId } });
    return profile?.setupScript ?? null;
  }

  /** Mounts to materialize into a container. Internal (host provisioning), no tenancy check. */
  async materializeMounts(repoId: string): Promise<WorkspaceMountView[]> {
    const rows = await this.workspaceMountRepo.find({ where: { repoId } });
    return rows.map((m) => ({ path: m.path, mode: m.mode }));
  }

  /** Secret files WITH decrypted contents to write into a container. Internal, no tenancy check. */
  async materializeSecrets(repoId: string): Promise<MaterializedSecretFile[]> {
    const rows = await this.workspaceSecretFileRepo.find({ where: { repoId } });
    return rows.map((s) => ({
      path: s.path,
      label: s.label,
      value: this.secretCipherService.decrypt(s.valueEnc),
    }));
  }
}
