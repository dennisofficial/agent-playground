import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** The repo root, resolved once. The engines' homes live UNDER the repo so they're co-located with the
 * project and isolated from anything personal in $HOME. Also the anchor for repo-local skill paths
 * (`{kind:'local', path:'skills/x'}` resolves here, NOT cwd, so a top-level `skills/` dir is found
 * regardless of which app's cwd boots the harness).
 *
 * Resolution order:
 *  1) `HARNESS_ROOT` env, when set — the IN-SANDBOX case: the daemon runs from a read-only build volume
 *     (mounted at `/daemon`) that deliberately EXCLUDES `.git`, so `git rev-parse` can't find the root
 *     and `process.cwd()` is `/workspace` (no harness `skills/` there). The host injects the mount path
 *     as the explicit anchor so vendored skills resolve to `/daemon/skills/x`.
 *  2) `git rev-parse --show-toplevel` — the normal host case (git stderr suppressed so a fallback never
 *     leaks a `fatal: not a git repository` line into the logs).
 *  3) `process.cwd()` — last resort. */
let repoRootCache: string | undefined;
export function repoRoot(): string {
  if (repoRootCache) return repoRootCache;
  const injected = process.env.HARNESS_ROOT?.trim();
  if (injected) {
    repoRootCache = injected;
    return repoRootCache;
  }
  try {
    repoRootCache = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
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
  // Defensive: the roster supplies controlled kebab ids, but never let an id escape the base dir.
  const safeAgent = agentId.replace(/[^a-z0-9_-]/gi, '_') || 'unknown';
  const dir = join(agentHomeBase(root), safeAgent, engine);
  // Idempotent — the CLIs expect the dir to exist (and won't create a deep custom path themselves).
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The base under which all per-employee engine homes (and the skill cache) live — repo-root
 * `.agent-home` by default, or AGENT_HOME_ROOT when set (a persistent volume in deployment). */
export function agentHomeBase(root: string | undefined): string {
  return root ?? join(repoRoot(), '.agent-home');
}

/** Shared, durable cache for git-sourced skills — cloned ONCE here, then symlinked into each
 * employee's home (the same skill repo must not clone per-employee). */
export function skillCacheDir(root: string | undefined): string {
  const dir = join(agentHomeBase(root), '.skill-cache');
  mkdirSync(dir, { recursive: true });
  return dir;
}
