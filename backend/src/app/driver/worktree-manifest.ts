import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Cache mount mode. There is deliberately NO shared read-write mode (cross-thread corruption risk). */
export type MountMode = 'per-thread' | 'shared-ro';

/** A secret file to render: `from` names a per-org stored secret; `path` is the worktree destination. */
export interface SecretSpec {
  path: string;
  from: string;
}

/** A cache/state directory bind-mounted into the container at `path` (worktree-relative). */
export interface MountSpec {
  path: string;
  mode: MountMode;
}

/** The parsed `.atlas/worktree.json`. Empty when the file is absent (feature is opt-in per repo). */
export interface WorktreeManifest {
  secrets: SecretSpec[];
  mounts: MountSpec[];
  seed: string[];
}

export interface LoadedManifest {
  manifest: WorktreeManifest;
  /** Non-fatal problems (bad/over-limit entries dropped) — surfaced by the caller as warnings. */
  warnings: string[];
}

const MANIFEST_REL = join('.atlas', 'worktree.json');
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 100; // per array
const MAX_PATH_LEN = 512;
const MAX_NAME_LEN = 128;

const EMPTY: WorktreeManifest = { secrets: [], mounts: [], seed: [] };

/**
 * Load + validate a repo's committed `.atlas/worktree.json` from a worktree. The manifest is
 * attacker-controllable (any org member can commit it), so this enforces size + count + field-length
 * limits and drops malformed entries (never throws on bad content — a broken manifest must not break
 * provisioning; it just hydrates nothing). Path SAFETY (traversal/symlink) is enforced separately by
 * `worktree-path-guard` at use time; this only does shape/limit validation.
 */
export function loadWorktreeManifest(worktreePath: string): LoadedManifest {
  const file = join(worktreePath, MANIFEST_REL);
  if (!existsSync(file)) return { manifest: EMPTY, warnings: [] };

  const warnings: string[] = [];
  try {
    if (statSync(file).size > MAX_BYTES) {
      return { manifest: EMPTY, warnings: [`worktree manifest exceeds ${MAX_BYTES} bytes — ignored`] };
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') {
      return { manifest: EMPTY, warnings: ['worktree manifest is not an object — ignored'] };
    }
    const obj = raw as Record<string, unknown>;

    const secrets = parseSecrets(obj.secrets, warnings);
    const mounts = parseMounts(obj.mounts, warnings);
    const seed = parseSeed(obj.seed, warnings);
    return { manifest: { secrets, mounts, seed }, warnings };
  } catch (err) {
    return { manifest: EMPTY, warnings: [`worktree manifest is unreadable: ${(err as Error).message}`] };
  }
}

function asArray(v: unknown, label: string, warnings: string[]): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`worktree manifest "${label}" is not an array — ignored`);
    return [];
  }
  if (v.length > MAX_ENTRIES) {
    warnings.push(`worktree manifest "${label}" exceeds ${MAX_ENTRIES} entries — truncated`);
    return v.slice(0, MAX_ENTRIES);
  }
  return v;
}

function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LEN;
}

function parseSecrets(v: unknown, warnings: string[]): SecretSpec[] {
  const out: SecretSpec[] = [];
  for (const e of asArray(v, 'secrets', warnings)) {
    const o = e as Record<string, unknown>;
    if (!o || !validPath(o.path) || typeof o.from !== 'string' || !o.from || o.from.length > MAX_NAME_LEN) {
      warnings.push('worktree manifest: dropped invalid secrets[] entry');
      continue;
    }
    out.push({ path: o.path, from: o.from });
  }
  return out;
}

function parseMounts(v: unknown, warnings: string[]): MountSpec[] {
  const out: MountSpec[] = [];
  for (const e of asArray(v, 'mounts', warnings)) {
    const o = e as Record<string, unknown>;
    const mode = o?.mode === 'shared-ro' ? 'shared-ro' : 'per-thread';
    if (!o || !validPath(o.path)) {
      warnings.push('worktree manifest: dropped invalid mounts[] entry');
      continue;
    }
    if (o.mode !== undefined && o.mode !== 'per-thread' && o.mode !== 'shared-ro') {
      warnings.push(`worktree manifest: mounts[] entry "${String(o.path)}" has unknown mode — defaulting to per-thread`);
    }
    out.push({ path: o.path, mode });
  }
  return out;
}

function parseSeed(v: unknown, warnings: string[]): string[] {
  const out: string[] = [];
  for (const e of asArray(v, 'seed', warnings)) {
    if (!validPath(e)) {
      warnings.push('worktree manifest: dropped invalid seed[] entry');
      continue;
    }
    out.push(e);
  }
  return out;
}
