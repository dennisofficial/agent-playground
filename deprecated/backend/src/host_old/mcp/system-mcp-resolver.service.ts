import { Injectable } from '@nestjs/common';
import { buildSystemMcpServers, type SystemMcpServer } from './system-mcp-registry';

@Injectable()
export class SystemMcpResolver {
  async resolveForOrg(_orgId: string): Promise<SystemMcpServer[]> {
    return buildSystemMcpServers();
  }
}
