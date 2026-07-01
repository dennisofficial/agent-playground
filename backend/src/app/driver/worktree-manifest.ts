import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isReservedMountPath } from '../sandbox/container-paths';

/**
 * Cache/state mount mode.
 * - `per-thread` = its own host dir (no cross-thread write contention).
 * - `shared-ro` = one immutable host dir mounted read-only into every thread.
 * - `shared-rw` = one PER-REPO host dir mounted read-write across all of a repo's sandboxes. Used for
 *   persistent auth STATE (e.g. `.gcloud`) that must survive sandbox reap and be reused by every job.
 *   The concurrent-writer race (two jobs refreshing a token at once) is accepted: login is rare and
 *   refresh is near-atomic; worst case is one job re-auths, not corruption.
 */
export type MountMode = 'per-thread' | 'shared-ro' | 'shared-rw';

/** A cache/state directory bind-mounted into the container at `path` (worktree-relative). */
export interface MountSpec {
  path: string;
  mode: MountMode;
}

/**
 * The parsed `atlas.json` (repo root). Empty when absent (feature is opt-in per repo). Carries only the
 * NON-re-derivable, NON-secret setup inputs: cache/auth `mounts` + golden `seed`. Secret name→path
 * bindings live in the encrypted grant store (DB), NOT here — a repo-controlled file plays no part in
 * secret rendering. There is deliberately no boot recipe: how to run the app is re-derived by the agent
 * from the repo's own `package.json`/README/`CLAUDE.md` (see docs/adr/0002).
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

/** Current manifest location (repo root). */
const MANIFEST_REL = 'atlas.json';
/** Legacy location — read as a fallback so already-onboarded repos keep working until they re-onboard. */
const LEGACY_MANIFEST_REL = join('.atlas', 'worktree.json');
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 100; // per array
const MAX_PATH_LEN = 512;

const EMPTY: WorktreeManifest = { mounts: [], seed: [] };

/**
 * Load + validate a repo's committed `atlas.json` (falling back to the legacy `.atlas/worktree.json`)
 * from a worktree. The manifest is attacker-controllable (any org member can commit it), so this
 * enforces size + count + field-length limits and drops malformed entries (never throws on bad content
 * — a broken manifest must not break provisioning; it just hydrates nothing). Path SAFETY
 * (traversal/symlink) is enforced separately by `worktree-path-guard` at use time; this only does
 * shape/limit validation.
 */
export function loadWorktreeManifest(worktreePath: string): LoadedManifest {
  const current = join(worktreePath, MANIFEST_REL);
  const file = existsSync(current) ? current : join(worktreePath, LEGACY_MANIFEST_REL);
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

    const mounts = parseMounts(obj.mounts, warnings);
    const seed = parseSeed(obj.seed, warnings);
    return { manifest: { mounts, seed }, warnings };
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

const MOUNT_MODES: readonly MountMode[] = ['per-thread', 'shared-ro', 'shared-rw'];

function parseMounts(v: unknown, warnings: string[]): MountSpec[] {
  const out: MountSpec[] = [];
  for (const e of asArray(v, 'mounts', warnings)) {
    const o = e as Record<string, unknown>;
    const mode: MountMode = MOUNT_MODES.includes(o?.mode as MountMode) ? (o.mode as MountMode) : 'per-thread';
    if (!o || !validPath(o.path)) {
      warnings.push('worktree manifest: dropped invalid mounts[] entry');
      continue;
    }
    // Reserved paths (e.g. `.pnpm-store`) are bound by the system itself under /workspace; a manifest
    // mount at the same target would collide → Docker "Duplicate mount point" → the sandbox can't be
    // created → every turn on the thread wedges. Drop them here so a bad manifest can't hard-fail.
    if (isReservedMountPath(o.path)) {
      warnings.push(`worktree manifest: mounts[] entry "${o.path}" is auto-managed by the system — ignored`);
      continue;
    }
    if (o.mode !== undefined && !MOUNT_MODES.includes(o.mode as MountMode)) {
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
