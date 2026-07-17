
import { BRIDGE_SERVER_NAME } from '@workspace/shared';
export { BRIDGE_SERVER_NAME };

export function qualifyBridgeToolNames(toolNames: string[]): string[] {
  return toolNames.map((name) => `mcp__${BRIDGE_SERVER_NAME}__${name}`);
}

export interface BridgeClaudeOptions {
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  bridgeToolNames: string[];
}

export function buildBridgeClaudeOptions(
  server: unknown,
  toolNames: string[],
): BridgeClaudeOptions {
  return {
    extraClaudeOptions: { mcpServers: { [BRIDGE_SERVER_NAME]: server } },
    bridgeToolNames: qualifyBridgeToolNames(toolNames),
  };
}
