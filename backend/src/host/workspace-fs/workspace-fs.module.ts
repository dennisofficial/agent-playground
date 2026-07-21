import { CreateModule } from '@workspace/nestjs-core';
import { GithubModule } from '../github/github.module';
import { ProvisionStatusModule } from '../provision-status/provision-status.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { GitCloneService } from './git-clone.service';
import { SecretFileWriter } from './secret-file-writer';
import { WorkspaceProvisionProcessor } from './workspace-provision.processor';

@CreateModule({
  imports: [WorkspaceProfileModule, GithubModule, ProvisionStatusModule],
  queues: [WorkspaceProvisionProcessor],
  processors: [WorkspaceProvisionProcessor],
  // Non-exported: only the processor drives them, so nothing outside this module can reach a host-side clone.
  providers: [GitCloneService, SecretFileWriter],
})
export class WorkspaceFsModule {}
