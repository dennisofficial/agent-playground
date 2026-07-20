import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { McpServerEntity, RepoEntity } from '../persistence/entities';
import { McpOAuthCallbackController } from './mcp-oauth-callback.controller';
import { McpOAuthService } from './mcp-oauth.service';
import { McpProbeService } from './mcp-probe.service';
import { McpResolver } from './mcp-resolver.service';
import { McpServerStore } from './mcp-server.store';
import { McpServersController } from './mcp-servers.controller';
import { SystemMcpResolver } from './system-mcp-resolver.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([McpServerEntity, RepoEntity], DB_CONNECTION)],
  controllers: [McpServersController, McpOAuthCallbackController],
  providers: [McpServerStore, McpResolver, McpProbeService, McpOAuthService, SystemMcpResolver],
  exports: [McpServerStore, McpResolver, McpProbeService, McpOAuthService, SystemMcpResolver],
})
export class McpModule {}
