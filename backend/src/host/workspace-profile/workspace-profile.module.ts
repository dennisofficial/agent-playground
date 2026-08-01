import { CreateModule } from '@dltech/nestjs-core';
import { OrgModule } from '../org/org.module';
import { RepoModule } from '../repo/repo.module';
import { InstallAwarenessRule } from './jit/install-awareness.rule';
import { WorkspaceProfileService } from './workspace-profile.service';

@CreateModule({
  imports: [OrgModule, RepoModule],
  services: [WorkspaceProfileService],
  providers: [InstallAwarenessRule],
})
export class WorkspaceProfileModule {}
