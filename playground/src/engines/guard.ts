import { isAbsolute, relative, resolve } from 'node:path';

/**
 * The project root — the single boundary every worker engine's file/shell access is jailed to.
 * Extracted here so the same checks back (a) the LangChain worker tools, and (b) the Claude
 * adapter's `canUseTool` guard (and inform the Codex sandbox config).
 */
export const ROOT = process.cwd();

/**
 * Resolve an agent-supplied path against the project root, throwing if it escapes (absolute
 * out-of-tree paths, `..` traversal). The root itself is allowed (rel === ''). Used by the
 * throwing LangChain tools in tools.ts.
 */
export function resolveInCwd(p: string): string {
  const resolved = resolve(ROOT, p);
  const rel = relative(ROOT, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${p}" escapes the project directory — refused. Stay within ${ROOT}.`);
  }
  return resolved;
}

/** Non-throwing variant for permission guards (canUseTool): true if `p` resolves inside the root. */
export function isInsideRoot(p: string): boolean {
  const rel = relative(ROOT, resolve(ROOT, p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// Best-effort guard-rails against obviously destructive shell forms. NOT a real sandbox.
const BASH_DENY = [
  /\brm\s+-rf\s+\/(?!\S)/, // rm -rf /
  /\bsudo\b/,
  /:\(\)\s*\{/, // fork bomb :(){
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/(?:etc|usr|bin|sbin|var|dev|sys|proc)\b/, // redirect into system dirs
  /(^|\s)~\//, // home-dir expansion (outside cwd)
];

/** Returns a refusal reason if the command hits a blocked destructive pattern, else null. */
export function bashDenyReason(command: string): string | null {
  for (const rule of BASH_DENY) {
    if (rule.test(command)) return `command matches a blocked destructive pattern (${rule})`;
  }
  return null;
}

// Best-effort detection of obviously MUTATING shell forms — used only during a PLAN pass to keep it
// read-only. Leaky by design (the hard guarantee is denying Write/Edit); this just stops a planner
// from sneaking a change through the shell. Read-only commands (ls, cat, git status/diff/log, grep,
// rg, find, head, tail) are unaffected.
const BASH_WRITE = [
  /(^|\s)(rm|mv|cp|mkdir|rmdir|touch|ln|chmod|chown|tee)\s/,
  /\b(npm|pnpm|yarn|pip|cargo)\s+(i|install|add|remove|uninstall|update)\b/,
  /\bgit\s+(commit|add|push|merge|rebase|reset|checkout|restore|apply|stash|clean|rm|mv|tag)\b/,
  /\bsed\s+-i\b/,
  /[^>]>>?[^>]/, // output redirection (write/append) — excludes 2>&1-style fd dups
];

/** Returns a reason if the command would MUTATE the workspace (for planning read-only), else null. */
export function bashWriteReason(command: string): string | null {
  for (const rule of BASH_WRITE) {
    if (rule.test(command)) return `it would modify the workspace (${rule})`;
  }
  return null;
}
