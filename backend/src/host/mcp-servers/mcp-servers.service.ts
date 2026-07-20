import { Injectable } from '@nestjs/common';
import { McpServerRepo } from '../../_lib/database/entities/mcp-server.entity';

export interface McpServerRow {
  name: string;
  enabled: boolean;
}

/**
 * Third-party MCP-server catalog (provisioning). Exported directly and injected by the sandbox — no port
 * (one impl, no cycle). SHELL: `listForRepo` returns `[]` until resolution logic lands.
 */
@Injectable()
export class McpServersService {
  constructor(private readonly repo: McpServerRepo) {}

  async listForRepo(_orgId: string, _repoId: string): Promise<McpServerRow[]> {
    return await Promise.resolve([]);
  }
}
