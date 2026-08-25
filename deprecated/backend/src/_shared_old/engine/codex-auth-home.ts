import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atlasAgentHomeBase, engineHomeLeaf, type EngineHomeKey } from './engine-home';

export function codexAuthHomeDir(root: string | undefined, key: EngineHomeKey): string {
  const home = join(engineHomeLeaf(atlasAgentHomeBase(root), key), 'codex-sub');
  mkdirSync(home, { recursive: true });
  return home;
}

export function readCodexAuthHome(root: string | undefined, key: EngineHomeKey): string | null {
  try {
    return readFileSync(join(codexAuthHomeDir(root, key), 'auth.json'), 'utf8');
  } catch {
    return null;
  }
}

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

export function assertValidCodexAuthJson(parsed: unknown): void {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CodexAuthInvalidError('not a JSON object');
  }
  const obj = parsed as { OPENAI_API_KEY?: unknown; tokens?: unknown };
  const hasApiKey = typeof obj.OPENAI_API_KEY === 'string' && obj.OPENAI_API_KEY.length > 0;
  const tokens = obj.tokens;

  if (hasApiKey && (tokens === undefined || tokens === null)) return;

  if (typeof tokens !== 'object' || tokens === null) {
    throw new CodexAuthInvalidError('missing the "tokens" object (and no OPENAI_API_KEY)');
  }
  const t = tokens as Record<string, unknown>;
  const missing = (['id_token', 'access_token', 'refresh_token'] as const).filter(
    (k) => typeof t[k] !== 'string' || (t[k] as string).length === 0,
  );
  if (missing.length > 0) {
    throw new CodexAuthInvalidError(`tokens is missing required field(s): ${missing.join(', ')}`);
  }
}

export interface CodexMcpBridge {
  serverPath: string;
  toolNames: string[];
  env: Record<string, string>;
}

export interface CodexMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type CodexExtraMcpServers = Record<string, CodexMcpServer>;

function tomlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

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
    throw new CodexAuthInvalidError('not valid JSON (expected the full auth.json object)');
  }
  assertValidCodexAuthJson(parsed);

  const home = codexAuthHomeDir(root, key);
  writeFileSync(join(home, 'auth.json'), secret, { mode: 0o600 });

  const blocks: string[] = [];
  if (mcpBridge && mcpBridge.toolNames.length > 0) {
    const env = {
      ...mcpBridge.env,
      BRIDGE_TOOLS: mcpBridge.toolNames.join(','),
    };
    blocks.push(...mcpServerBlock('atlasbridge', 'node', [mcpBridge.serverPath], env));
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
