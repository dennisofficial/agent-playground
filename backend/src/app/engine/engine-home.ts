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
 * Layout: `<base>/<orgId>/<repoId>/<jobId>/<type>/[<subId>/]<engine>` — nested per org → repo → job →
 * surface, so two jobs (or two surfaces of the SAME job — brain vs build vs plan-review vs autofix vs
 * review) never share engine state, and the tree reads like the product model instead of an opaque flat
 * slug. `subId` is an extra path segment for a surface that runs several PARALLEL sub-sessions under one
 * (org,repo,job,type) — e.g. one autofix review-lens per lens id, or an orchestrator's writer sub-sessions —
 * absent for the one primary session per type. Every part is sanitized independently (see
 * {@link safeHomeKey}) so none of it can escape the base dir or inject a path separator. Default base is the
 * gitignored, repo-relative `.atlas-state/agent-home` (see {@link repoStateDir}); override with
 * `AGENT_HOME_ROOT` — point it at a persistent volume in deployment. The result is passed through as
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the subprocess env.
 *
 * Greenfield: this replaces the old flat `<safeHomeKey(sandboxKey)>/<engine>` layout keyed by an ad-hoc
 * compound string (`brain-<org>-<repo>-<job>`, `<repoId>--<branch>`, …) — old homes are simply abandoned, no
 * migration (a resumed session under the old path starts fresh, same as any other home rename).
 */
export type EngineHomeType = 'brain' | 'build' | 'plan-review' | 'autofix' | 'review';

/** The structured parts that key an engine home — see the module doc for the resulting layout. */
export interface EngineHomeKey {
  orgId: string;
  repoId: string;
  jobId: string;
  type: EngineHomeType;
  /** Extra path segment for a parallel sub-session sharing this (org,repo,job,type) — e.g. an autofix
   *  review-lens/fix id. Absent for the one primary session per type. */
  subId?: string;
}

export function atlasEngineHomeDir(
  root: string | undefined,
  engine: 'claude' | 'codex',
  key: EngineHomeKey,
): string {
  const dir = join(engineHomeLeaf(atlasAgentHomeBase(root), key), engine);
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
 * The `<orgId>/<repoId>/<jobId>/<type>/[<subId>]` leaf under `base`, BEFORE the trailing engine-specific
 * segment (`claude`/`codex` for {@link atlasEngineHomeDir}, `codex-sub` for `codexAuthHomeDir`) — shared by
 * both so they land under the exact same nested tree for a given key.
 */
export function engineHomeLeaf(base: string, key: EngineHomeKey): string {
  const parts = [safeHomeKey(key.orgId), safeHomeKey(key.repoId), safeHomeKey(key.jobId), key.type];
  if (key.subId) parts.push(safeHomeKey(key.subId));
  return join(base, ...parts);
}

/**
 * A single deterministic string for an {@link EngineHomeKey} — for in-memory cache keys (e.g. the Codex
 * client cache), NOT a filesystem path (use {@link engineHomeLeaf} / {@link atlasEngineHomeDir} for that).
 */
export function engineHomeKeyString(key: EngineHomeKey): string {
  return [key.orgId, key.repoId, key.jobId, key.type, key.subId ?? ''].join(':');
}

/**
 * Sanitize ONE path segment (an org/repo/job id, or a `subId`) of an {@link EngineHomeKey}. Two jobs:
 *   1. Sanitize — never let a segment escape the base dir (path traversal / odd chars → `_`).
 *   2. Collapse an over-long segment to a SHORT, unsplittable token — mainly a defense-in-depth backstop now
 *      that ids are individually short (UUIDs pass through untouched), but still guards a pathological long
 *      `subId` (e.g. an arbitrary lens/writer id) the same way.
 */
export function safeHomeKey(part: string): string {
  const safe = part.replace(/[^a-z0-9_-]/gi, '_') || 'default';
  if (safe.length <= 40) return safe;
  const dash = safe.indexOf('-');
  const prefix = safe.slice(0, dash > 0 ? Math.min(dash, 12) : 12);
  return `${prefix}_${createHash('sha256').update(safe).digest('hex').slice(0, 12)}`;
}
