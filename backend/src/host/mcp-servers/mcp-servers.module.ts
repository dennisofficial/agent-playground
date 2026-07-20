import { CreateModule } from '@workspace/nestjs-core';
import { McpServer, McpServerRepo } from './entities/mcp-server.entity';
import { McpServersService } from './mcp-servers.service';

/**
 * Third-party MCP-server catalog (provisioning). Scaffold: the `mcp_servers` entity + `McpServersService`
 * the future SandboxModule reads. Distinct from the workspace-profile agent tool server.
 */
@CreateModule({
  entities: [{ entity: McpServer, repoClass: McpServerRepo }],
  services: [McpServersService],
})
export class McpServersModule {}
