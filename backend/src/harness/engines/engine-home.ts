import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The repo root, resolved once via git toplevel (fallback: cwd). The engines' homes live UNDER the
 * repo so they're co-located with the project and isolated from anything personal in $HOME. */
let repoRootCache: string | undefined;
function repoRoot(): string {
  if (repoRootCache) return repoRootCache;
  try {
    repoRootCache = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    repoRootCache = process.cwd();
  }
  return repoRootCache;
}

/**
 * Resolves (and creates) an isolated config/state HOME for a worker engine's subprocess, so the
 * `claude` / `codex` CLIs the SDKs spawn never read the developer's personal `~/.claude` / `~/.codex`
 * — their settings, skills, hooks, and (for codex) `config.toml` would otherwise leak in and make
 * local behavior diverge from deployment. Pinning the home here also gives the engines' session
 * transcripts (the resume handles) a stable, durable location instead of mixing into a personal dir.
 *
 * PER EMPLOYEE: each employee owns their own home (`<base>/.agent-home/<agentId>/<engine>`) because
 * skills and MCP servers are granted per-employee, not team-wide — sharing one home would hand every
 * employee the same toolset. Default base is the repo root (gitignored); override via AGENT_HOME_ROOT
 * — point it at a persistent volume in deployment. Pass the result through as CLAUDE_CONFIG_DIR /
 * CODEX_HOME in the subprocess env.
 */
export function engineHomeDir(
  root: string | undefined,
  engine: 'claude' | 'codex',
  agentId: string,
): string {
  const base = root ?? join(repoRoot(), '.agent-home');
  // Defensive: the roster supplies controlled kebab ids, but never let an id escape the base dir.
  const safeAgent = agentId.replace(/[^a-z0-9_-]/gi, '_') || 'unknown';
  const dir = join(base, safeAgent, engine);
  // Idempotent — the CLIs expect the dir to exist (and won't create a deep custom path themselves).
  mkdirSync(dir, { recursive: true });
  return dir;
}
