import { Global, Module } from '@nestjs/common';
import { WorkspaceProfileService } from './workspace-profile.service';

@Global()
@Module({
  providers: [
    WorkspaceProfileService,
  ],
  exports: [WorkspaceProfileService],
})
export class WorkspaceProfileModule {}
