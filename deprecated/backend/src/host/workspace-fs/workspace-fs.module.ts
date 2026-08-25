import { CreateModule } from '@dltech/nestjs-core';
import { GithubModule } from '../github/github.module';
import { ProvisionStatusModule } from '../provision-status/provision-status.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { GitCloneService } from './git-clone.service';
import { SecretFileWriter } from './secret-file-writer';
import { WorkspacePathsService } from './workspace-paths.service';
import { WorkspaceProvisionProcessor } from './workspace-provision.processor';

@CreateModule({
  imports: [WorkspaceProfileModule, GithubModule, ProvisionStatusModule],
  queues: [WorkspaceProvisionProcessor],
  processors: [WorkspaceProvisionProcessor],
  providers: [GitCloneService, SecretFileWriter, WorkspacePathsService],
})
export class WorkspaceFsModule {}
