import type { SessionMode } from '@shared/domain';
import { LSP_SERVER_NAME, LSP_TOOL_NAMES, qualifyLspToolNames } from '@shared/engine/lsp-tools';

export interface LspBridgeOptions {
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  lspToolNames: string[];
}

export function buildLspBridgeOptions(
  mode: SessionMode,
  workspaceDir: string,
): LspBridgeOptions | undefined {
  if (mode !== 'execute') return undefined;
  return {
    extraClaudeOptions: {
      mcpServers: {
        [LSP_SERVER_NAME]: {
          command: '/usr/local/bin/node',
          args: [
            '/usr/local/lib/atlas/atlas-lsp-server.mjs',
            '--workspace',
            workspaceDir,
            '--lsp',
            'typescript-language-server',
            '--',
            '--stdio',
          ],
        },
      },
    },
    lspToolNames: qualifyLspToolNames(LSP_TOOL_NAMES),
  };
}
