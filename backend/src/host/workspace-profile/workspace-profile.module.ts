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
import { WorkspaceProfileService } from './workspace-profile.service';

@CreateModule({
  imports: [OrgModule, RepoModule],
  entities: [
    { entity: WorkspaceProfile, repoClass: WorkspaceProfileRepo },
    { entity: WorkspaceMount, repoClass: WorkspaceMountRepo },
    { entity: WorkspaceSecretFile, repoClass: WorkspaceSecretFileRepo },
  ],
  services: [WorkspaceProfileService],
  providers: [InstallAwarenessRule],
})
export class WorkspaceProfileModule {}
