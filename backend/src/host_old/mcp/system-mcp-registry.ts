import { LSP_SERVER_NAME, LSP_TOOL_NAMES } from '../../_shared/engine/lsp-tools';

export interface SystemMcpServer {
  name: string;
  description: string;
  transport: 'http' | 'sse' | 'stdio';
  tools: string[];
  active: boolean;
  inactiveReason?: string;
}

export function buildSystemMcpServers(): SystemMcpServer[] {
  return [
    {
      name: LSP_SERVER_NAME,
      description:
        'TypeScript language server — precise symbol rename, references, definitions, hover and ' +
        'diagnostics against the turn’s worktree. Active on every build turn.',
      transport: 'stdio',
      tools: [...LSP_TOOL_NAMES],
      active: true,
    },
  ];
}
