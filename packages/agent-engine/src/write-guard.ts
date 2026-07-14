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

export function evaluateWriteGuard(toolName: string, input: unknown, ctx: WriteGuardCtx): WriteGuardVerdict {
  if (!MUTATING_TOOL_NAMES.has(toolName)) return { allow: true };

  if (ctx.readOnly) {
    return { allow: false, reason: 'This is a read-only turn — no file writes.' };
  }

  if (ctx.roots.length > 0) {
    for (const path of extractPaths(input)) {
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

/** Is `path` inside `root` (after resolution)? Confines writes to the worktree. */
function isInsideRoot(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(root, path);
  return p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`);
}

/**
 * Pulls the path(s) a write/edit call targets: Claude's Write/Edit shape (`{file_path}`), or Codex's
 * fileChange approval raw payload (a single `{path}` or `{changes: [{path, kind}]}`). Codex's approval-raw
 * shape isn't 100% pinned, so an unrecognized shape returns an empty array — "can't identify a path to
 * check" means no root violation is raised, erring on the side of NOT blocking rather than crashing.
 */
function extractPaths(input: unknown): string[] {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (typeof r.file_path === 'string') return [r.file_path];
  if (typeof r.path === 'string') return [r.path];
  if (Array.isArray(r.changes)) {
    return r.changes
      .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>).path : undefined))
      .filter((p): p is string => typeof p === 'string');
  }
  return [];
}
