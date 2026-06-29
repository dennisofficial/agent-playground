import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoStateDir } from '../state-root';

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
 * isn't needed. Default base is the gitignored, repo-relative `.atlas-state/agent-home` (see
 * {@link repoStateDir}); override with `AGENT_HOME_ROOT` — point it at a persistent volume in
 * deployment. The result is passed through as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the subprocess env.
 */
export function atlasEngineHomeDir(
  root: string | undefined,
  engine: 'claude' | 'codex',
  sandboxKey: string,
): string {
  const dir = join(atlasAgentHomeBase(root), safeHomeKey(sandboxKey), engine);
  // Idempotent — the CLIs expect the dir to exist (they won't create a deep custom path themselves).
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The base under which all Atlas engine homes live — `AGENT_HOME_ROOT` when set, else the
 * repo-relative `.atlas-state/agent-home`. */
export function atlasAgentHomeBase(root: string | undefined): string {
  return root ?? repoStateDir('agent-home');
}

/**
 * The single on-disk directory NAME for a sandbox key (one path component, used by both the Claude
 * home here and the Codex auth home). Two jobs:
 *   1. Sanitize — never let a key escape the base dir (path traversal / odd chars → `_`).
 *   2. Collapse over-long keys to a SHORT, unsplittable token. A raw brain key is
 *      `brain-<orgUuid>-<repoUuid>-<threadUuid>` — a ~95-char hyphen-run that *looks* segmentable, so
 *      a model copying a spill-file path under it reliably turns one hyphen into a `/` and the Read
 *      404s (the dir it invents doesn't exist). We keep a short readable prefix (up to the first `-`,
 *      capped) then a content hash: one token, no UUID-looking seams to split on, still stable+unique.
 *      NOTE: this renames homes vs the old raw-key layout, so in-flight resumable sessions whose
 *      transcript lived under the old path start fresh ONCE (DB transcript is untouched).
 */
export function safeHomeKey(sandboxKey: string): string {
  const safe = sandboxKey.replace(/[^a-z0-9_-]/gi, '_') || 'default';
  if (safe.length <= 40) return safe;
  const dash = safe.indexOf('-');
  const prefix = safe.slice(0, dash > 0 ? Math.min(dash, 12) : 12);
  return `${prefix}_${createHash('sha256').update(safe).digest('hex').slice(0, 12)}`;
}
