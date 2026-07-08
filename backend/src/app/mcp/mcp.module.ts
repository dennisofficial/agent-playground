import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { McpServerEntity, RepoEntity } from '../persistence/entities';
import { McpOAuthService } from './mcp-oauth.service';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';
import { McpProbeService } from './mcp-probe.service';
import { McpResolver } from './mcp-resolver.service';
import { McpServerStore } from './mcp-server.store';
import { McpServersController } from './mcp-servers.controller';
import { SystemMcpResolver } from './system-mcp-resolver.service';

/**
 * The MCP layer — user-defined MCP servers (System/Org/Repo tiers) + the `McpResolver` seam the brain and
 * driver turn-assembly paths read through to thread `RunEngineArgs.userMcpServers`. `SystemMcpResolver`
 * resolves the read-only System tier (built-ins) with live availability for the console. `@Global` (like
 * `OnboardingModule`) so those factories inject `McpResolver` with zero per-module import churn.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([McpServerEntity, RepoEntity], DB_CONNECTION)],
  controllers: [McpServersController, McpOAuthCallbackController],
  providers: [McpServerStore, McpResolver, McpProbeService, McpOAuthService, SystemMcpResolver],
  exports: [McpServerStore, McpResolver, McpProbeService, McpOAuthService, SystemMcpResolver],
})
export class McpModule {}
