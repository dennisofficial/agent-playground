import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MountMode, MountSpec } from '../sandbox/container-paths';
import { isExternalMountPath, isReservedMountPath } from '../sandbox/container-paths';

export interface WorktreeManifest {
  mounts: MountSpec[];
}

export interface LoadedManifest {
  manifest: WorktreeManifest;
  warnings: string[];
}

const MANIFEST_REL = 'atlas.json';
const LEGACY_MANIFEST_REL = join('.atlas', 'worktree.json');
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 100; // per array
const MAX_PATH_LEN = 512;

const EMPTY: WorktreeManifest = { mounts: [] };

export function loadLegacyManifestFile(worktreePath: string): LoadedManifest {
  const current = join(worktreePath, MANIFEST_REL);
  const file = existsSync(current) ? current : join(worktreePath, LEGACY_MANIFEST_REL);
  if (!existsSync(file)) return { manifest: EMPTY, warnings: [] };

  const warnings: string[] = [];
  try {
    if (statSync(file).size > MAX_BYTES) {
      return {
        manifest: EMPTY,
        warnings: [`legacy worktree manifest exceeds ${MAX_BYTES} bytes — ignored`],
      };
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') {
      return {
        manifest: EMPTY,
        warnings: ['legacy worktree manifest is not an object — ignored'],
      };
    }
    const obj = raw as Record<string, unknown>;

    const mounts = parseMounts(obj.mounts, warnings);
    return { manifest: { mounts }, warnings };
  } catch (err) {
    return {
      manifest: EMPTY,
      warnings: [`legacy worktree manifest is unreadable: ${(err as Error).message}`],
    };
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
    const mode: MountMode = MOUNT_MODES.includes(o?.mode as MountMode)
      ? (o.mode as MountMode)
      : 'per-thread';
    if (!o || !validPath(o.path)) {
      warnings.push('legacy worktree manifest: dropped invalid mounts[] entry');
      continue;
    }
    if (isExternalMountPath(o.path)) {
      warnings.push(
        `legacy worktree manifest: mounts[] entry "${o.path}" is an absolute (external) path — not allowed from a committed file, ignored`,
      );
      continue;
    }
    if (isReservedMountPath(o.path)) {
      warnings.push(
        `legacy worktree manifest: mounts[] entry "${o.path}" is auto-managed by the system — ignored`,
      );
      continue;
    }
    if (o.mode !== undefined && !MOUNT_MODES.includes(o.mode as MountMode)) {
      warnings.push(
        `legacy worktree manifest: mounts[] entry "${String(o.path)}" has unknown mode — defaulting to per-thread`,
      );
    }
    out.push({ path: o.path, mode });
  }
  return out;
}
