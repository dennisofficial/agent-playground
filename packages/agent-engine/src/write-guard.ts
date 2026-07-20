import { resolve as resolvePath } from 'node:path';

/**
 * Shared, engine-agnostic write-guard decision: read-only-turn denial + worktree-root confinement. Used by
 * BOTH Claude's `canUseTool` and Codex's `onApproval` so the two engines enforce ONE decision function
 * instead of drifting predicates.
 */
export interface WriteGuardCtx {
  readOnly: boolean;
  /** Confinement roots (absolute paths); empty ⇒ no root check performed. */
  roots: string[];
}

export interface WriteGuardVerdict {
  allow: boolean;
  reason?: string;
}

// Claude's mutating tool names, plus Codex's `CodexApprovalKind` for a file-mutating approval request
// ('fileChange' — modeled as a literal string here rather than imported from `@workspace/codex-sdk`, so
// this file stays free of a codex-sdk dependency).
const MUTATING_TOOL_NAMES = new Set(['Write', 'Edit', 'fileChange']);

export function evaluateWriteGuard(
  toolName: string,
  input: unknown,
  ctx: WriteGuardCtx,
): WriteGuardVerdict {
  const paths = extractPaths(input);
  const mutating =
    MUTATING_TOOL_NAMES.has(toolName) ||
    (toolName === 'permissions' && hasWritePermissionRequest(input));
  if (!mutating) return { allow: true };

  if (ctx.readOnly) {
    return {
      allow: false,
      reason: 'This is a read-only turn — no file writes.',
    };
  }

  if (ctx.roots.length > 0) {
    if (paths.length === 0 && toolName === 'permissions') {
      return {
        allow: false,
        reason: `Write outside the allowed roots (${ctx.roots.join(', ')}) is not allowed: requested file-system write permission`,
      };
    }
    for (const path of paths) {
      if (!ctx.roots.some((root) => isInsideRoot(path, root))) {
        return {
          allow: false,
          reason: `Write outside the allowed roots (${ctx.roots.join(', ')}) is not allowed: ${path}`,
        };
      }
    }
  }

  return { allow: true };
}

function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * Pulls the path(s) a write/edit call targets: Claude's Write/Edit shape (`{file_path}`), Codex fileChange
 * permission requests (`{grantRoot}`), the legacy fixture shape (`{path}` / `{changes: [{path}]}`), and
 * Codex permission-profile write grants. An unrecognized fileChange shape returns an empty array — "can't
 * identify a path to check" means no root violation is raised, erring on the side of NOT blocking rather
 * than crashing.
 */
function extractPaths(input: unknown): string[] {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (typeof r.file_path === 'string') return [r.file_path];
  if (typeof r.path === 'string') return [r.path];
  if (typeof r.grantRoot === 'string') return [r.grantRoot];
  if (Array.isArray(r.changes)) {
    return r.changes
      .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).path : undefined))
      .filter((p): p is string => typeof p === 'string');
  }
  return extractPermissionWritePaths(r.permissions);
}

function hasWritePermissionRequest(input: unknown): boolean {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const permissions =
    r.permissions && typeof r.permissions === 'object'
      ? (r.permissions as Record<string, unknown>)
      : {};
  const fileSystem =
    permissions.fileSystem && typeof permissions.fileSystem === 'object'
      ? (permissions.fileSystem as Record<string, unknown>)
      : undefined;
  if (!fileSystem) return false;
  if (Array.isArray(fileSystem.write) && fileSystem.write.length > 0) return true;
  if (!Array.isArray(fileSystem.entries)) return false;
  return fileSystem.entries.some((entry) => {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    return e.access === 'write';
  });
}

function extractPermissionWritePaths(value: unknown): string[] {
  const permissions = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const fileSystem =
    permissions.fileSystem && typeof permissions.fileSystem === 'object'
      ? (permissions.fileSystem as Record<string, unknown>)
      : undefined;
  if (!fileSystem) return [];

  const paths: string[] = [];
  if (Array.isArray(fileSystem.write)) {
    paths.push(...fileSystem.write.filter((p): p is string => typeof p === 'string'));
  }
  if (Array.isArray(fileSystem.entries)) {
    for (const entry of fileSystem.entries) {
      const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
      if (e.access !== 'write') continue;
      const path = e.path && typeof e.path === 'object' ? (e.path as Record<string, unknown>) : {};
      if (path.type === 'path' && typeof path.path === 'string') paths.push(path.path);
    }
  }
  return paths;
}
