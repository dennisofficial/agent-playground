
import { MCP_HUB_PORT as SHARED_MCP_HUB_PORT } from '@shared/mcp/mcp-hub-config';
import { posix } from 'node:path';

export const CONTAINER_AGENT_HOME = '/.atlas';

export const CONTAINER_HOME = '/home/atlas';

export const CONTAINER_WORKTREE = '/workspace';

export const CONTAINER_GIT_COMMON = `${CONTAINER_AGENT_HOME}/git-common`;

export const CONTAINER_SKILLS_STORE = '/skills';

export const CONTAINER_SKILLS_MANAGED = '/skills-managed';

export const CONTAINER_SKILLS_MANAGED_GIT = '/skills-managed-git';

export const CONTAINER_PNPM_STORE = `${CONTAINER_AGENT_HOME}/pnpm-store`;

export const RESERVED_WORKTREE_MOUNTS: ReadonlySet<string> = new Set(['.pnpm-store']);

export type MountMode = 'per-thread' | 'shared-ro' | 'shared-rw';

export interface MountSpec {
  path: string;
  mode: MountMode;
}

export const MAX_MOUNT_PATH_LEN = 512;

export function normalizeMountPath(p: string): string {
  return p
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

export function isReservedMountPath(p: string): boolean {
  return RESERVED_WORKTREE_MOUNTS.has(normalizeMountPath(p));
}

export const CONTAINER_FNM_STORE = `${CONTAINER_AGENT_HOME}/fnm`;

export const CONTAINER_CONTEXT = '/context';

export const CONTAINER_PLAYGROUND = '/playground';

export const MCP_HUB_PORT = SHARED_MCP_HUB_PORT;

export const CONTAINER_MCP_HUB_DIR = `${CONTAINER_AGENT_HOME}/mcp-hub`;

export const CONTAINER_MCP_HUB_CONFIG = `${CONTAINER_AGENT_HOME}/mcp-hub.json`;

export const GITHUB_TOKEN_FILE = `${CONTAINER_AGENT_HOME}/github-token`;

export function isExternalMountPath(path: string): boolean {
  return posix.isAbsolute(path);
}

export const RESERVED_CONTAINER_MOUNTS: readonly string[] = [
  CONTAINER_WORKTREE, // /workspace
  CONTAINER_AGENT_HOME, // /.atlas (covers the nested pnpm-store/fnm/git-common binds under it too)
  CONTAINER_HOME,
  CONTAINER_FNM_STORE,
  CONTAINER_CONTEXT,
  CONTAINER_GIT_COMMON,
  CONTAINER_PLAYGROUND,
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/run',
];

export function isReservedContainerPath(path: string): boolean {
  const norm = posix.normalize(path).replace(/\/+$/, '') || '/';
  if (norm === '/') return true;
  return RESERVED_CONTAINER_MOUNTS.some((r) => {
    const rr = r.replace(/\/+$/, '');
    return norm === rr || norm.startsWith(`${rr}/`) || rr.startsWith(`${norm}/`);
  });
}

export function normalizeMounts(raw: unknown): {
  mounts: MountSpec[];
  warnings: string[];
} {
  if (!Array.isArray(raw)) return { mounts: [], warnings: [] };
  const out: MountSpec[] = [];
  const warnings: string[] = [];
  for (const e of raw) {
    const o = e as Record<string, unknown>;
    const path = String(o?.['path'] ?? '').trim();
    if (!path || path.split('/').includes('..') || path.length > MAX_MOUNT_PATH_LEN) continue;
    if (isExternalMountPath(path)) {
      if (isReservedContainerPath(path)) {
        warnings.push(
          `mount "${path}" targets a reserved/system container path (do not mount it) — dropped`,
        );
        continue;
      }
    } else if (isReservedMountPath(path)) {
      warnings.push(`mount "${path}" is auto-managed by the system (do not add it) — dropped`);
      continue;
    }
    const mode: MountMode =
      o?.['mode'] === 'shared-ro' || o?.['mode'] === 'shared-rw' ? o['mode'] : 'per-thread';
    out.push({ path, mode });
  }
  return { mounts: out, warnings };
}
