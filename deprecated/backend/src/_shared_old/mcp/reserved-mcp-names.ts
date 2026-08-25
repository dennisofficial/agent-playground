export const RESERVED_MCP_SERVER_NAMES: readonly string[] = [
  'atlas-host-bridge', // the general host tool bridge (Claude)
  'workspace-profile', // the dedicated Workspace Profile bridge (Claude)
  'atlas-prod', // the dedicated atlas-prod diagnostics + gated-write bridge (Claude)
  'atlasbridge', // the Codex tool bridge
  'atlas-lsp-ts', // TS LSP bridge
];

export const RESERVED_MCP_SERVER_NAME_SET: ReadonlySet<string> = new Set(
  RESERVED_MCP_SERVER_NAMES.map((n) => n.toLowerCase()),
);

export function isReservedMcpName(name: string | undefined | null): boolean {
  return !!name && RESERVED_MCP_SERVER_NAME_SET.has(name.toLowerCase());
}
