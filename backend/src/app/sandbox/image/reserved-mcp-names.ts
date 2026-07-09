/**
 * The single source of truth for MCP server names the system already owns — a USER-defined MCP
 * server may never reuse one, or its definition would shadow the orchestration plumbing (user
 * servers are merged AFTER the system bridges in the SDK `mcpServers` option, so a name collision
 * would win). Enforced in three places that must agree: the sandbox render
 * (`user-mcp-bridge-options.ts`), the `propose_mcp_servers` tool validation, and the owner approve
 * endpoint (`web-surface.controller.ts`). Kept here — pure strings, safe to bundle into the sandbox
 * entrypoint — so the three can't drift (they previously did: the sandbox copy was missing
 * `graphify`/`cocoindex`).
 */

/** Names the system owns: the two in-process host bridges, the Codex bridge, and the system-tier servers. */
export const RESERVED_MCP_SERVER_NAMES: readonly string[] = [
  'atlas-host-bridge', // the general host tool bridge (Claude)
  'workspace-profile', // the dedicated Workspace Profile bridge (Claude)
  'atlasbridge', // the Codex tool bridge
  'atlas-lsp-ts', // TS LSP bridge
  'context7', // remote docs bridge
  'graphify', // system-tier server
  'cocoindex', // system-tier server
];

/** Case-insensitive membership set for validation (`name.toLowerCase()`). */
export const RESERVED_MCP_SERVER_NAME_SET: ReadonlySet<string> = new Set(
  RESERVED_MCP_SERVER_NAMES.map((n) => n.toLowerCase()),
);

/** True when `name` collides with a reserved system server (case-insensitive). */
export function isReservedMcpName(name: string | undefined | null): boolean {
  return !!name && RESERVED_MCP_SERVER_NAME_SET.has(name.toLowerCase());
}
