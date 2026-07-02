import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isReservedMountPath } from '../sandbox/container-paths';
import type { MountMode, MountSpec } from '../sandbox/container-paths';

/**
 * The shape of a legacy committed `atlas.json` (repo root) or its predecessor `.atlas/worktree.json`.
 * Worktree config (mounts + seed) now lives in the DB (see `WorktreeConfigStore`) — this parser exists
 * ONLY to import an already-onboarded repo's committed file, once, into the DB (see
 * `WorktreeConfigStore.importLegacyIfEmpty`). It is NOT part of the live hydration path.
 */
export interface WorktreeManifest {
  mounts: MountSpec[];
  seed: string[];
}

export interface LoadedManifest {
  manifest: WorktreeManifest;
  /** Non-fatal problems (bad/over-limit entries dropped) — surfaced by the caller as warnings. */
  warnings: string[];
}

/** Legacy manifest location (repo root). */
const MANIFEST_REL = 'atlas.json';
/** Older legacy location — read as a fallback for repos onboarded before the atlas.json rename. */
const LEGACY_MANIFEST_REL = join('.atlas', 'worktree.json');
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 100; // per array
const MAX_PATH_LEN = 512;

const EMPTY: WorktreeManifest = { mounts: [], seed: [] };

/**
 * Load + validate a repo's committed legacy manifest file (`atlas.json`, falling back to the older
 * `.atlas/worktree.json`) from a worktree. The file is attacker-controllable (any org member can commit
 * it), so this enforces size + count + field-length limits and drops malformed entries (never throws on
 * bad content — a broken file must not break the one-time import; it just imports nothing). Path SAFETY
 * (traversal/symlink) is enforced separately by `worktree-path-guard` at use time; this only does
 * shape/limit validation.
 */
export function loadLegacyManifestFile(worktreePath: string): LoadedManifest {
  const current = join(worktreePath, MANIFEST_REL);
  const file = existsSync(current) ? current : join(worktreePath, LEGACY_MANIFEST_REL);
  if (!existsSync(file)) return { manifest: EMPTY, warnings: [] };

  const warnings: string[] = [];
  try {
    if (statSync(file).size > MAX_BYTES) {
      return { manifest: EMPTY, warnings: [`legacy worktree manifest exceeds ${MAX_BYTES} bytes — ignored`] };
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') {
      return { manifest: EMPTY, warnings: ['legacy worktree manifest is not an object — ignored'] };
    }
    const obj = raw as Record<string, unknown>;

    const mounts = parseMounts(obj.mounts, warnings);
    const seed = parseSeed(obj.seed, warnings);
    return { manifest: { mounts, seed }, warnings };
  } catch (err) {
    return { manifest: EMPTY, warnings: [`legacy worktree manifest is unreadable: ${(err as Error).message}`] };
  }
}

function asArray(v: unknown, label: string, warnings: string[]): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    warnings.push(`legacy worktree manifest "${label}" is not an array — ignored`);
    return [];
  }
  if (v.length > MAX_ENTRIES) {
    warnings.push(`legacy worktree manifest "${label}" exceeds ${MAX_ENTRIES} entries — truncated`);
    return v.slice(0, MAX_ENTRIES);
  }
  return v;
}

function validPath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length <= MAX_PATH_LEN;
}

const MOUNT_MODES: readonly MountMode[] = ['per-thread', 'shared-ro', 'shared-rw'];

function parseMounts(v: unknown, warnings: string[]): MountSpec[] {
  const out: MountSpec[] = [];
  for (const e of asArray(v, 'mounts', warnings)) {
    const o = e as Record<string, unknown>;
    const mode: MountMode = MOUNT_MODES.includes(o?.mode as MountMode) ? (o.mode as MountMode) : 'per-thread';
    if (!o || !validPath(o.path)) {
      warnings.push('legacy worktree manifest: dropped invalid mounts[] entry');
      continue;
    }
    // Reserved paths (e.g. `.pnpm-store`) are bound by the system itself under /workspace; importing a
    // manifest mount at the same target would collide → Docker "Duplicate mount point". Drop it here so
    // a bad legacy manifest can't hard-fail the import.
    if (isReservedMountPath(o.path)) {
      warnings.push(`legacy worktree manifest: mounts[] entry "${o.path}" is auto-managed by the system — ignored`);
      continue;
    }
    if (o.mode !== undefined && !MOUNT_MODES.includes(o.mode as MountMode)) {
      warnings.push(`legacy worktree manifest: mounts[] entry "${String(o.path)}" has unknown mode — defaulting to per-thread`);
    }
    out.push({ path: o.path, mode });
  }
  return out;
}

function parseSeed(v: unknown, warnings: string[]): string[] {
  const out: string[] = [];
  for (const e of asArray(v, 'seed', warnings)) {
    if (!validPath(e)) {
      warnings.push('legacy worktree manifest: dropped invalid seed[] entry');
      continue;
    }
    out.push(e);
  }
  return out;
}
