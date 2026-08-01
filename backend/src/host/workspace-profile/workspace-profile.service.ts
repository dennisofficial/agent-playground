import { SecretCipherService } from '@lib/crypto/secret-cipher.service';
import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import type { EMountMode } from '@workspace/shared';

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
    private readonly prismaService: PrismaService,
    private readonly secretCipherService: SecretCipherService,
  ) {}

  /** Read-only aggregate of the repo's workspace profile (safe fields only). */
  describe(_orgId: string, _repoId: string): Promise<WorkspaceProfileSnapshot> {
    throw new Error('not implemented');
  }

  /**
   * The cold-boot setup script the sandbox runs on first provision. Internal (host provisioning), no
   * tenancy check — `WorkspaceProfile` is `NO_CLIENT_ACCESS`, so this goes through `PrismaService`;
   * the caller-resolved `repoId` is the only scope this internal path has ever had.
   */
  async materializeSetupScript(repoId: string): Promise<string | null> {
    const profile = await this.prismaService.workspaceProfile.findUnique({ where: { repoId } });
    return profile?.setupScript ?? null;
  }

  /** Mounts to materialize into a container. Internal (host provisioning), no tenancy check. */
  async materializeMounts(repoId: string): Promise<WorkspaceMountView[]> {
    const rows = await this.prismaService.workspaceMount.findMany({ where: { repoId } });
    return rows.map((m) => ({ path: m.path, mode: m.mode as EMountMode }));
  }

  /** Secret files WITH decrypted contents to write into a container. Internal, no tenancy check. */
  async materializeSecrets(repoId: string): Promise<MaterializedSecretFile[]> {
    const rows = await this.prismaService.workspaceSecretFile.findMany({ where: { repoId } });
    return rows.map((s) => ({
      path: s.path,
      label: s.label,
      value: this.secretCipherService.decrypt(s.valueEnc),
    }));
  }
}
