import { CreateModule } from '@workspace/nestjs-core';
import {
  WorkspaceMount,
  WorkspaceMountRepo,
} from '../../_lib/database/entities/workspace-mount.entity';
import {
  WorkspaceProfile,
  WorkspaceProfileRepo,
} from '../../_lib/database/entities/workspace-profile.entity';
import {
  WorkspaceSecretFile,
  WorkspaceSecretFileRepo,
} from '../../_lib/database/entities/workspace-secret-file.entity';
import { OrgModule } from '../org/org.module';
import { RepoModule } from '../repo/repo.module';
import { InstallAwarenessRule } from './jit/install-awareness.rule';
import { MountService } from './mount.service';
import { SecretFileService } from './secret-file.service';
import { WorkspaceProfileService } from './workspace-profile.service';

/**
 * The Atlas-managed per-repo workspace state (instructions + mounts + secret files) and the agent-facing
 * tool surface that edits it. Exports its services directly (no port — one impl, no cycle) for consumers
 * like SandboxModule. Contributes the `install-awareness` JIT rule (discovered by `JitRegistry`, NOT imported
 * here — the decorator comes from the dependency-free `_shared/jit/contracts`). CryptoModule is global, so
 * `SecretCipherService` needs no import. Imports `OrgModule` (tenancy) + `RepoModule` (RepoRepo).
 */
@CreateModule({
  imports: [OrgModule, RepoModule],
  entities: [
    { entity: WorkspaceProfile, repoClass: WorkspaceProfileRepo },
    { entity: WorkspaceMount, repoClass: WorkspaceMountRepo },
    { entity: WorkspaceSecretFile, repoClass: WorkspaceSecretFileRepo },
  ],
  services: [WorkspaceProfileService, MountService, SecretFileService],
  providers: [InstallAwarenessRule], // discovered by JitRegistry via @JitHook metadata
})
export class WorkspaceProfileModule {}
