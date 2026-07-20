import { Injectable } from '@nestjs/common';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { SkillsService } from '../skills/skills.service';
import { WorkspaceProfileService } from '../workspace-profile/workspace-profile.service';

/**
 * Builds a job's workspace container from the three inputs: the workspace profile (mounts + secret files +
 * setup), the MCP-servers catalog, and the skills catalog — all injected directly as concrete services (no
 * ports; same process, one impl each). SHELL this pass; the real docker/mount/exposure logic lands later.
 */
@Injectable()
export class SandboxService {
  constructor(
    private readonly profile: WorkspaceProfileService,
    private readonly mcp: McpServersService,
    private readonly skills: SkillsService,
  ) {}

  provision(_orgId: string, _repoId: string): Promise<void> {
    throw new Error('not implemented');
  }
}
