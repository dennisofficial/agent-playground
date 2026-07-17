import type { ResolvedMcpServer } from '@shared/engine/engine.types';
import { mcpHubUrl } from '@shared/mcp/mcp-hub-config';
import { describe, expect, it } from 'vitest';
import { buildUserMcpBridgeOptions } from './user-mcp-bridge-options';

describe('buildUserMcpBridgeOptions', () => {
  it('returns undefined for empty / missing input', () => {
    expect(buildUserMcpBridgeOptions(undefined)).toBeUndefined();
    expect(buildUserMcpBridgeOptions([])).toBeUndefined();
  });

  it('fronts an http server with a local hub route (http + alwaysLoad), NOT the upstream url/headers', () => {
    const servers: ResolvedMcpServer[] = [
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app',
        headers: { Authorization: 'Bearer x' },
      },
    ];
    const out = buildUserMcpBridgeOptions(servers)!;
    expect(out.extraClaudeOptions.mcpServers).toEqual({
      linear: { type: 'http', url: mcpHubUrl('linear'), alwaysLoad: true },
    });
    expect(out.userMcpToolNames).toEqual(['mcp__linear']);
    // Remote servers are Claude-only — nothing rendered for Codex.
    expect(out.codexExtraMcpServers).toEqual({});
  });

  it('fronts a stdio server via the hub for Claude but keeps the DIRECT stdio block for Codex', () => {
    const servers: ResolvedMcpServer[] = [
      {
        name: 'fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@fs/mcp'],
        env: { TOKEN: 't' },
      },
    ];
    const out = buildUserMcpBridgeOptions(servers)!;
    expect(out.extraClaudeOptions.mcpServers).toEqual({
      fs: { type: 'http', url: mcpHubUrl('fs'), alwaysLoad: true },
    });
    expect(out.codexExtraMcpServers).toEqual({
      fs: { command: 'npx', args: ['-y', '@fs/mcp'], env: { TOKEN: 't' } },
    });
    expect(out.userMcpToolNames).toEqual(['mcp__fs']);
  });

  it('skips servers whose name collides with a reserved system server', () => {
    const servers: ResolvedMcpServer[] = [
      { name: 'workspace-profile', transport: 'http', url: 'https://evil' },
      { name: 'atlas-lsp-ts', transport: 'stdio', command: 'x' },
    ];
    expect(buildUserMcpBridgeOptions(servers)).toBeUndefined();
  });

  it('drops a malformed server (stdio w/o command, http w/o url) but keeps the good ones', () => {
    const servers: ResolvedMcpServer[] = [
      { name: 'bad-stdio', transport: 'stdio' },
      { name: 'bad-http', transport: 'sse' },
      { name: 'good', transport: 'http', url: 'https://ok' },
    ];
    const out = buildUserMcpBridgeOptions(servers)!;
    expect(Object.keys(out.extraClaudeOptions.mcpServers)).toEqual(['good']);
    expect(out.extraClaudeOptions.mcpServers.good).toEqual({
      type: 'http',
      url: mcpHubUrl('good'),
      alwaysLoad: true,
    });
  });
});
