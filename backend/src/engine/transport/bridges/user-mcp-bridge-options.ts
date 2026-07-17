import type { CodexExtraMcpServers } from '@shared/engine/codex-auth-home';
import type { ResolvedMcpServer } from '@shared/engine/engine.types';
import { mcpHubUrl } from '@shared/mcp/mcp-hub-config';

import { isReservedMcpName } from '@shared/mcp/reserved-mcp-names';

export interface UserMcpBridgeOptions {
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  userMcpToolNames: string[];
  codexExtraMcpServers: CodexExtraMcpServers;
}

export function buildUserMcpBridgeOptions(
  servers: ResolvedMcpServer[] | undefined,
): UserMcpBridgeOptions | undefined {
  if (!servers || servers.length === 0) return undefined;

  const mcpServers: Record<string, unknown> = {};
  const userMcpToolNames: string[] = [];
  const codexExtraMcpServers: CodexExtraMcpServers = {};

  for (const s of servers) {
    if (!s.name || isReservedMcpName(s.name)) continue;

    if (s.transport === 'stdio') {
      if (!s.command) continue;
      const entry: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
      } = {
        command: s.command,
      };
      if (s.args && s.args.length > 0) entry.args = s.args;
      if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
      codexExtraMcpServers[s.name] = entry;
    } else {
      if (!s.url) continue;
    }
    mcpServers[s.name] = {
      type: 'http',
      url: mcpHubUrl(s.name),
      alwaysLoad: true,
    };
    userMcpToolNames.push(`mcp__${s.name}`);
  }

  if (Object.keys(mcpServers).length === 0) return undefined;
  return {
    extraClaudeOptions: { mcpServers },
    userMcpToolNames,
    codexExtraMcpServers,
  };
}
