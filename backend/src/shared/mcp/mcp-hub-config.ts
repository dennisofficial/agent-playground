/**
 * The wire contract between the HOST (which resolves + writes it) and the in-sandbox MCP HUB (which reads
 * it). The host writes this JSON to `CONTAINER_MCP_HUB_CONFIG` (`/.atlas/mcp-hub.json`) at provision and on
 * every refresh; the hub (`mcp-hub-server.ts`) reads it on boot, on `SIGHUP`, and on a slow mtime re-stat.
 *
 * Kept dependency-light (only a type import) so BOTH sides can import it: the host via `SandboxManager`,
 * the engine app via `buildUserMcpBridgeOptions`, and the hub via the esbuild bundle.
 */
import type { ResolvedMcpServer } from '@shared/engine/engine.types';

/** Loopback port the in-sandbox MCP hub listens on. */
export const MCP_HUB_PORT = 8785;

/**
 * The identity a STDIO upstream must be spawned under so it matches the per-turn `docker exec` context —
 * NOT the hub's own (root / PID1) context. The host fills this from `hostExecUser()` + the neutral mount
 * paths. Remote (http/sse) upstreams ignore it (they're in-process network clients).
 */
export interface McpHubSpawnIdentity {
  /** Host uid to drop to when spawning a stdio child (so worktree writes stay host-owned, not root). */
  uid?: number;
  /** Host gid to drop to when spawning a stdio child. */
  gid?: number;
  /** cwd for stdio children — the neutral worktree mount (`/workspace`). */
  cwd: string;
  /** `HOME` for stdio children — the durable per-repo agent home (`/home/atlas`). */
  home: string;
  /** Base env every stdio child inherits (PATH, HOME, LANG…), BEFORE the server's own `env` overlays it. */
  baseEnv: Record<string, string>;
}

/** The whole hub config file. `servers` is the resolved UNION of the sandbox's enabled user MCP servers. */
export interface McpHubConfig {
  spawn: McpHubSpawnIdentity;
  servers: ResolvedMcpServer[];
}

/**
 * The loopback URL the per-turn engine points a Claude `type:'http'` server at for `serverName`. One route
 * per upstream, so the SDK still sees N distinct servers with their real names (`mcp__<name>__<tool>`
 * preserved). The hub decodes the path segment back to the server name.
 */
export function mcpHubUrl(serverName: string): string {
  return `http://127.0.0.1:${MCP_HUB_PORT}/${encodeURIComponent(serverName)}`;
}

/**
 * Parse the hub config JSON defensively — a malformed/half-written file (host mid-write) must never crash
 * the hub. Returns `null` on any problem; the caller keeps its current connections until the next good read.
 */
export function parseHubConfig(raw: string): McpHubConfig | null {
  try {
    const v = JSON.parse(raw) as Partial<McpHubConfig>;
    if (!v || typeof v !== 'object') return null;
    if (!Array.isArray(v.servers)) return null;
    const spawn = v.spawn;
    if (
      !spawn ||
      typeof spawn.cwd !== 'string' ||
      typeof spawn.home !== 'string'
    )
      return null;
    return {
      spawn: { ...spawn, baseEnv: spawn.baseEnv ?? {} },
      servers: v.servers,
    };
  } catch {
    return null;
  }
}

/**
 * A stable content key for one upstream — used by the hub's reconcile diff to decide add / drop / leave. Any
 * change to transport / endpoint / command / secrets flips the key, forcing a reconnect for just that server
 * (unchanged servers keep their live connection, so a config edit to server A never churns server B).
 */
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
