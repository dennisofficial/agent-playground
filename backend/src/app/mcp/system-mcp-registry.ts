import { LSP_SERVER_NAME, LSP_TOOL_NAMES } from '@shared/engine/lsp-tools';

/** A built-in MCP server, shown READ-ONLY in the console so operators know what the agent already has. */
export interface SystemMcpServer {
  name: string;
  description: string;
  transport: 'http' | 'sse' | 'stdio';
  /** The tool names the server exposes (addressed as `mcp__<name>__<tool>`). */
  tools: string[];
  /** Whether this built-in is actually live right now, for this org + deployment. */
  active: boolean;
  /** When inactive, what to configure to turn it on (shown in the console). */
  inactiveReason?: string;
}

/**
 * The system-tier MCP servers with their REAL, per-request availability. Names + tool lists are the exact
 * constants the sandbox registers on execute turns (`engine/*-tools.ts`) — this is not a hand-kept mirror,
 * it reuses those constants directly, so the console reflects what the agent actually has.
 *
 * All of these attach on execute/build turns only (plan/review turns get none). This stays a PURE function
 * so the active-state logic is unit-testable without DI. The host tool bridge (`atlas-host-bridge`) is
 * intentionally omitted — it's orchestration plumbing, not a user-meaningful tool server.
 */
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
