import { describe, expect, it } from 'vitest';
import { RESERVED_MCP_SERVER_NAMES, isReservedMcpName } from '../reserved-mcp-names';

describe('reserved-mcp-names', () => {
  it('reserves both host bridges, the Codex bridge, and the system-tier servers', () => {
    for (const name of [
      'atlas-host-bridge',
      'workspace-profile',
      'atlas-prod',
      'atlasbridge',
      'atlas-lsp-ts',
    ]) {
      expect(RESERVED_MCP_SERVER_NAMES).toContain(name);
    }
  });

  it('reserves the new workspace-profile bridge name so a user server cannot shadow it', () => {
    expect(isReservedMcpName('workspace-profile')).toBe(true);
    expect(isReservedMcpName('Workspace-Profile')).toBe(true); // case-insensitive
  });

  it('allows ordinary user server names', () => {
    expect(isReservedMcpName('github')).toBe(false);
    expect(isReservedMcpName('sentry')).toBe(false);
    expect(isReservedMcpName('')).toBe(false);
    expect(isReservedMcpName(undefined)).toBe(false);
  });
});
