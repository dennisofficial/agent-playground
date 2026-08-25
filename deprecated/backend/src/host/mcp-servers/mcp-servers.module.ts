import { CreateModule } from '@dltech/nestjs-core';
import { McpServersService } from './mcp-servers.service';

/**
 * Third-party MCP-server catalog (provisioning). Scaffold: the `mcp_servers` entity + `McpServersService`
 * the future SandboxModule reads. Distinct from the workspace-profile agent tool server.
 */
@CreateModule({
  services: [McpServersService],
})
export class McpServersModule {}
