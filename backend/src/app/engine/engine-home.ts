import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Atlas v2's isolated agent-home resolver — a clean-room rewrite of v1's `engine-home.ts` with the
 * skill-cache / per-employee machinery DROPPED (v2 engines run vanilla: credentials + an isolated
 * home, no skills/MCP). Its ONE job is to pin the Claude/Codex CLIs the SDKs spawn to a home Atlas
 * OWNS, never the developer's personal `~/.claude` / `~/.codex` — so their settings/hooks/config
 * can't leak in and make local behavior diverge from deployment, and session transcripts land in a
 * stable durable dir.
 *
 * Layout: `<base>/<sandboxKey>/<engine>`. The sandbox key (a per-feature scope) keeps two concurrent
 * features' engine state separate; passing a stable key (e.g. the project id) is fine when isolation
 * isn't needed. Default base is `~/.agent-playground/atlas-agent-home`; override with
 * `AGENT_HOME_ROOT` (or fall back to v1's `AGENT_HOME_ROOT`) — point it at a persistent volume
 * in deployment. The result is passed through as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the subprocess env.
 */
export function atlasEngineHomeDir(
  root: string | undefined,
  engine: 'claude' | 'codex',
  sandboxKey: string,
): string {
  // Defensive: never let a key escape the base dir (path traversal / odd chars).
  const safeKey = sandboxKey.replace(/[^a-z0-9_-]/gi, '_') || 'default';
  const dir = join(atlasAgentHomeBase(root), safeKey, engine);
  // Idempotent — the CLIs expect the dir to exist (they won't create a deep custom path themselves).
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The base under which all Atlas engine homes live — `AGENT_HOME_ROOT` when set, else the
 * v1 `AGENT_HOME_ROOT`, else `~/.agent-playground/atlas-agent-home`. */
export function atlasAgentHomeBase(root: string | undefined): string {
  return root ?? join(homedir(), '.agent-playground', 'atlas-agent-home');
}
