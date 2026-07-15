import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atlasAgentHomeBase,
  engineHomeLeaf,
  type EngineHomeKey,
} from './engine-home';

/**
 * The deterministic CODEX_HOME path for an engine-home key — the ONE place the overlay's location is
 * computed, so the writer ({@link ensureCodexAuthHome}) and the post-run reader ({@link readCodexAuthHome})
 * never drift. Idempotent mkdir (the CLI won't create a deep custom path itself).
 */
export function codexAuthHomeDir(
  root: string | undefined,
  key: EngineHomeKey,
): string {
  const home = join(engineHomeLeaf(atlasAgentHomeBase(root), key), 'codex-sub');
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * Read the overlay `auth.json` back after a turn. Codex rewrites this file IN PLACE when it refreshes
 * its short-lived tokens from the `refresh_token`, so the post-run content may differ from what we wrote
 * at turn start — the caller diffs it against the input secret to detect a refresh worth persisting.
 * Returns `null` when the file is absent/unreadable (nothing to persist).
 */
export function readCodexAuthHome(
  root: string | undefined,
  key: EngineHomeKey,
): string | null {
  try {
    return readFileSync(join(codexAuthHomeDir(root, key), 'auth.json'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Thrown when the Codex subscription secret isn't a usable `auth.json`. Carries an ACTIONABLE message
 * so the failure surfaces as an onboarding problem ("re-run codex login") instead of a serde error
 * four layers down in the Codex binary (`missing field 'id_token' at line 1 column N`).
 */
export class CodexAuthInvalidError extends Error {
  constructor(reason: string) {
    super(
      `Codex subscription credential is invalid: ${reason}. ` +
        `Re-run 'codex login' (ChatGPT plan) and re-store the FULL contents of ~/.codex/auth.json ` +
        `as the Codex secret — it must include tokens.id_token, tokens.access_token and tokens.refresh_token.`,
    );
    this.name = 'CodexAuthInvalidError';
  }
}

/**
 * Validate that a blob is a Codex `auth.json` the CLI can actually deserialize. Codex's Rust
 * `TokenData` struct requires `tokens.id_token` (a JWT) — a blob missing it fails DEEP in the binary
 * with an opaque `missing field 'id_token'`. We front-run that here with a clear message. An
 * `OPENAI_API_KEY`-only blob (no `tokens`) is also valid; we only demand the token fields when a
 * `tokens` object is present but incomplete, or when NEITHER auth path exists.
 */
export function assertValidCodexAuthJson(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodexAuthInvalidError('not a JSON object');
  }
  const obj = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown };
  const hasApiKey =
    typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY.length > 0;
  const tokens = obj.tokens;

  // API-key-only blob is a complete auth path on its own.
  if (hasApiKey && (tokens === undefined || tokens === null)) return;

  if (typeof tokens !== 'object' || tokens === null) {
    throw new CodexAuthInvalidError(
      'missing the "tokens" object (and no OPENAI_API_KEY)',
    );
  }
  const t = tokens as Record<string, unknown>;
  const missing = (
    ['id_token', 'access_token', 'refresh_token'] as const
  ).filter((k) => typeof t[k] !== 'string' || (t[k] as string).length === 0);
  if (missing.length > 0) {
    throw new CodexAuthInvalidError(
      `tokens is missing required field(s): ${missing.join(', ')}`,
    );
  }
}

/**
 * The Codex host tool bridge for an execute turn (e.g. `master_review`). Rendered into the per-sandbox
 * `config.toml` as an `[mcp_servers.atlasbridge]` block: codex spawns the in-sandbox MCP server, which
 * does the Redis `tool_request`/reply round-trip to the host (see `mcp-bridge-server.ts`). The `env` map
 * (TURN_ID/REDIS_URL/BRIDGE_TOOLS) is what the server reads to reach the turn's streams.
 */
export interface CodexMcpBridge {
  /** In-container path of the bundled MCP bridge server (`node <serverPath>`). */
  serverPath: string;
  /** Bare host tool names to expose (e.g. `['complete_thread','record_deviation']`). */
  toolNames: string[];
  /** Env for the spawned server: at least TURN_ID + REDIS_URL. */
  env: Record<string, string>;
}

/** A plain stdio MCP server to render as a `[mcp_servers.<name>]` config.toml block (command/args/env). */
export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Extra stdio MCP servers to register for a Codex execute turn ALONGSIDE the host tool bridge — keyed by
 * server name (the user-defined MCP servers resolved for this turn). Built once in the entrypoint (same
 * command/args/env as the Claude bridge, no drift) and rendered here into config.toml. See
 * `sandbox/image/user-mcp-bridge-options.ts`.
 */
export type CodexExtraMcpServers = Record<string, CodexMcpServer>;

/** Minimal TOML string escaper for the simple values we write (paths, ids, urls, tool-name CSV). */
function tomlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render one `[mcp_servers.<name>]` block (+ auto-approve + optional env sub-table). */
function mcpServerBlock(
  name: string,
  command: string,
  args: string[],
  env?: Record<string, string>,
): string[] {
  const lines = [
    `[mcp_servers.${name}]`,
    `command = ${tomlStr(command)}`,
    `args = [${args.map(tomlStr).join(', ')}]`,
    // Auto-approve this server's tool calls (no interactive approver in SDK mode). Short-circuits the MCP
    // approval gate before approval_policy, so sandboxMode:'workspace-write' is preserved.
    `default_tools_approval_mode = "approve"`,
    '',
  ];
  if (env && Object.keys(env).length > 0) {
    lines.push(
      `[mcp_servers.${name}.env]`,
      ...Object.entries(env).map(([k, v]) => `${k} = ${tomlStr(v)}`),
      '',
    );
  }
  return lines;
}

/**
 * Materialize a Codex SUBSCRIPTION home — an isolated CODEX_HOME owning its own `auth.json` (the
 * ChatGPT-plan credential), so a subscription run reads it instead of an API key. Idempotent (rewritten
 * each turn). NEVER the developer's personal ~/.codex.
 *
 * `secret` is the raw `auth.json` blob. It is VALIDATED before write so an incomplete blob (the
 * classic: a stale login missing `tokens.id_token`) fails with {@link CodexAuthInvalidError} up front
 * rather than as an opaque Codex-binary serde error mid-turn. Returns the absolute CODEX_HOME path to
 * pass through as the subprocess's CODEX_HOME.
 *
 * `mcpBridge` (optional) writes a `config.toml` with an `[mcp_servers.atlasbridge]` block +
 * `default_tools_approval_mode = "approve"` (spike-proven: auto-approves the MCP tool calls without an
 * interactive approver, and short-circuits BEFORE the `approval_policy` check so `workspace-write` is
 * kept — no `danger-full-access`). Omitted → no config.toml (read-only Codex turns need no bridge).
 *
 * NOTE: there is no "bare token" form — a valid Codex subscription credential is ALWAYS the full
 * auth.json object (it needs id_token + access_token + refresh_token together). A single opaque token
 * cannot be wrapped into a usable auth.json.
 */
export function ensureCodexAuthHome(
  root: string | undefined,
  key: EngineHomeKey,
  secret: string,
  mcpBridge?: CodexMcpBridge,
  extraMcpServers?: CodexExtraMcpServers,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new CodexAuthInvalidError(
      'not valid JSON (expected the full auth.json object)',
    );
  }
  assertValidCodexAuthJson(parsed);

  const home = codexAuthHomeDir(root, key);
  writeFileSync(join(home, 'auth.json'), secret, { mode: 0o600 });

  // Accumulate every MCP server block into ONE config.toml — the host tool bridge (atlasbridge) plus any
  // user-defined stdio MCP servers. Written only when at least one block exists (read-only turns get
  // neither, hence no config.toml).
  const blocks: string[] = [];
  if (mcpBridge && mcpBridge.toolNames.length > 0) {
    const env = {
      ...mcpBridge.env,
      BRIDGE_TOOLS: mcpBridge.toolNames.join(','),
    };
    blocks.push(
      ...mcpServerBlock('atlasbridge', 'node', [mcpBridge.serverPath], env),
    );
  }
  for (const [name, srv] of Object.entries(extraMcpServers ?? {})) {
    blocks.push(...mcpServerBlock(name, srv.command, srv.args ?? [], srv.env));
  }
  if (blocks.length > 0) {
    writeFileSync(join(home, 'config.toml'), blocks.join('\n'), {
      mode: 0o600,
    });
  }
  return home;
}
