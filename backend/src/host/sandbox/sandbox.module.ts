import { CreateModule } from '@workspace/nestjs-core';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { SkillsModule } from '../skills/skills.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { SandboxService } from './sandbox.service';

/**
 * Future-stub SandboxModule. Imports the three provisioning inputs and injects their services directly. No
 * runtime yet — this marks where container provisioning will live.
 */
@CreateModule({
  imports: [WorkspaceProfileModule, McpServersModule, SkillsModule],
  services: [SandboxService],
})
export class SandboxModule {}
