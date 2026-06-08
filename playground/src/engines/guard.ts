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
