/**
 * User-defined MCP servers → SDK option assembly. Mirrors `context7-bridge-options.ts` (remote): the SHAPE
 * of the options handed to the SDK lives here, unit-testable without spawning the bundled entrypoint.
 *
 * Input is `spec.userMcpServers` — the servers `McpResolver.resolveForTurn` picked for THIS turn's
 * org/repo/surface, already RESOLVED (secret header/env values inlined host-side). This file just renders
 * them per engine:
 *   - Claude: EVERY transport is presented via the persistent per-sandbox MCP HUB (`mcp-hub-server.ts`) on a
 *     local loopback route — `{ type:'http', url:'http://127.0.0.1:<port>/<name>', alwaysLoad:true }` — NOT
 *     the upstream config. The hub already holds the (once-per-sandbox) upstream connection, so this local
 *     attach is instant and `alwaysLoad` blocks turn-start until it connects → tools present at first
 *     inference (no per-turn re-spawn/re-handshake, no remote-connect race). The `mcp__<name>` whole-server
 *     wildcard is still emitted so every tool the server exposes is auto-approved. Names are preserved
 *     (one route per upstream → `mcp__<name>__<tool>` unchanged).
 *   - Codex: ONLY stdio servers, DIRECT (`CodexExtraMcpServers` → config.toml `[mcp_servers.<name>]`), since
 *     Codex's config.toml can't point at the hub's HTTP route. Remote (http/sse) user servers stay
 *     Claude-only. Routing Codex through the hub (+ remote support) is a follow-up (a stdio proxy shim).
 *
 * Servers whose name collides with a RESERVED system server (host bridge, LSP, Context7) are skipped
 * defensively so a user definition can never shadow the orchestration plumbing.
 */
import type { CodexExtraMcpServers } from '../../engine/codex-auth-home';
import type { ResolvedMcpServer } from '../../engine/engine.types';
import { mcpHubUrl } from './mcp-hub-config';

import { isReservedMcpName } from './reserved-mcp-names';

export interface UserMcpBridgeOptions {
  /** `{ mcpServers: { <name>: {...} } }` — spread verbatim into the SDK `Options` (Claude). */
  extraClaudeOptions: { mcpServers: Record<string, unknown> };
  /** `mcp__<name>` whole-server wildcards to auto-approve via `allowedTools` (Claude). */
  userMcpToolNames: string[];
  /** stdio servers only — rendered into config.toml `[mcp_servers.<name>]` blocks (Codex). */
  codexExtraMcpServers: CodexExtraMcpServers;
}

/**
 * Build the user-MCP options for a turn, or `undefined` when there are none. No mode gate here — the host
 * `McpResolver` already filtered by the turn's surface, so whatever arrives should be registered.
 */
export function buildUserMcpBridgeOptions(
  servers: ResolvedMcpServer[] | undefined,
): UserMcpBridgeOptions | undefined {
  if (!servers || servers.length === 0) return undefined;

  const mcpServers: Record<string, unknown> = {};
  const userMcpToolNames: string[] = [];
  const codexExtraMcpServers: CodexExtraMcpServers = {};

  for (const s of servers) {
    if (!s.name || isReservedMcpName(s.name)) continue;

    // Per-transport validity gate + the DIRECT Codex block (stdio only) — the hub does not front Codex.
    if (s.transport === 'stdio') {
      if (!s.command) continue;
      const entry: { command: string; args?: string[]; env?: Record<string, string> } = {
        command: s.command,
      };
      if (s.args && s.args.length > 0) entry.args = s.args;
      if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
      codexExtraMcpServers[s.name] = entry;
    } else {
      if (!s.url) continue;
      // Remote user servers are Claude-only (no Codex block).
    }
    // CLAUDE: front EVERY transport with the persistent per-sandbox hub on a local loopback route +
    // `alwaysLoad` (tools present at turn-1 against the warm hub). Upstream config/secrets never ride the
    // turn — the hub holds them (host-written config, see mcp-hub-config.ts).
    mcpServers[s.name] = { type: 'http', url: mcpHubUrl(s.name), alwaysLoad: true };
    userMcpToolNames.push(`mcp__${s.name}`);
  }

  if (Object.keys(mcpServers).length === 0) return undefined;
  return { extraClaudeOptions: { mcpServers }, userMcpToolNames, codexExtraMcpServers };
}
