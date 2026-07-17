import type { ResolvedMcpServer } from '@shared/engine/engine.types';

export const MCP_HUB_PORT = 8785;

export interface McpHubSpawnIdentity {
  uid?: number;
  gid?: number;
  cwd: string;
  home: string;
  baseEnv: Record<string, string>;
}

export interface McpHubConfig {
  spawn: McpHubSpawnIdentity;
  servers: ResolvedMcpServer[];
}

export function mcpHubUrl(serverName: string): string {
  return `http://127.0.0.1:${MCP_HUB_PORT}/${encodeURIComponent(serverName)}`;
}

export function parseHubConfig(raw: string): McpHubConfig | null {
  try {
    const v = JSON.parse(raw) as Partial<McpHubConfig>;
    if (!v || typeof v !== 'object') return null;
    if (!Array.isArray(v.servers)) return null;
    const spawn = v.spawn;
    if (!spawn || typeof spawn.cwd !== 'string' || typeof spawn.home !== 'string') return null;
    return {
      spawn: { ...spawn, baseEnv: spawn.baseEnv ?? {} },
      servers: v.servers,
    };
  } catch {
    return null;
  }
}

export function serverKey(s: ResolvedMcpServer): string {
  return JSON.stringify([
    s.name,
    s.transport,
    s.url ?? '',
    s.headers ?? {},
    s.command ?? '',
    s.args ?? [],
    s.env ?? {},
  ]);
}
