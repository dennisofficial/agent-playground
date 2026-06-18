import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * The process root — the default boundary worker file/shell access is jailed to. Extracted here so
 * the same checks back (a) the LangChain worker tools, and (b) the Claude adapter's `canUseTool`
 * guard (and inform the Codex sandbox config).
 *
 * A worker that has its own isolated workspace (a git workspace — see workspaces/workspace.service.ts)
 * runs jailed to THAT directory instead, not the process root, so concurrent workers can't read or
 * clobber each other's trees (or the trunk). The active workspace is carried per async context below.
 */
export const ROOT = process.cwd();

/**
 * The jail root for the CURRENTLY EXECUTING worker. Set (via `withActiveRoot`) to the session's
 * workspace for the duration of its engine turn, so the in-process LangChain tools resolve paths and
 * shell `cwd` against the workspace rather than ROOT. Unset → ROOT (the chat process). The SDK
 * engines (claude/codex) additionally pass their own `cwd` to the subprocess; this store is what
 * keeps the langgraph in-process tools isolated to match.
 */
const activeRootStore = new AsyncLocalStorage<string>();

/** The jail root for the current async context — the active worker's workspace, or ROOT. */
export function activeRoot(): string {
  return activeRootStore.getStore() ?? ROOT;
}

/** Run `fn` with `root` as the active jail root for everything it (transitively) awaits. */
export function withActiveRoot<T>(root: string, fn: () => T): T {
  return activeRootStore.run(root, fn);
}

/**
 * Resolve an agent-supplied path against the active root, throwing if it escapes (absolute
 * out-of-tree paths, `..` traversal). The root itself is allowed (rel === ''). Used by the
 * throwing LangChain tools in tools.ts.
 */
export function resolveInCwd(p: string, root: string = activeRoot()): string {
  const resolved = resolve(root, p);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Path "${p}" escapes the project directory — refused. Stay within ${root}.`,
    );
  }
  return resolved;
}

/** Non-throwing variant for permission guards (canUseTool): true if `p` resolves inside the root. */
export function isInsideRoot(p: string, root: string = activeRoot()): boolean {
  const rel = relative(root, resolve(root, p));
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
    if (rule.test(command))
      return `command matches a blocked destructive pattern (${rule})`;
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

/**
 * RELAXED SANDBOX GUARD — daemon-only self-validation posture (Phase 10).
 *
 * Inside a disposable sandbox the engine *is* the isolation: an EXECUTE turn must be free to
 * `pnpm install`, start long-running dev servers in the background (`pnpm dev &`), `curl localhost`,
 * and `docker compose up` its own backing services — none of which can collide with the host or other
 * sandboxes, because the container's filesystem/network/Docker are all private to it. So in this mode
 * we drop the read-only-flavored extra restrictions (`bashWriteReason` — irrelevant on an execute turn
 * anyway, and only ever applied on read-only turns) and, for Codex, grant the workspace-write sandbox
 * network access (its workspace-write mode blocks the network by default — that's what stops `curl`
 * and `pnpm install`).
 *
 * What does NOT relax, ever:
 *  - `bashDenyReason` (rm -rf /, fork bombs, mkfs, dd, sudo, redirects into system dirs) stays active.
 *  - The path jail (`isInsideRoot`/`resolveInCwd`) stays active — writes are still confined to the
 *    session's worktree (a relaxed bash guard is not a license to escape the checkout).
 *  - READ-ONLY turns (plan/investigate) are unaffected — they keep the full read-only guard. Relaxation
 *    is execute-only.
 *
 * Gating: a single env switch the daemon/image sets (`SANDBOX_GUARD_RELAXED=true`). Read DIRECTLY from
 * `process.env` — NOT via the typed `EnvService` — exactly like the daemon reads `WORKSPACE_ID` /
 * `DAEMON_BOOTSTRAP_TOKEN`, so the host's `EnvService`/`IEnvConfig` typing is untouched and the HOST
 * (where the flag is never set) behaves byte-identically to before. Parsed once at module load: the
 * value is fixed for a process's lifetime, and avoiding a per-call `process.env` read keeps the hot
 * `canUseTool` path allocation-free.
 */
const SANDBOX_GUARD_RELAXED =
  (process.env.SANDBOX_GUARD_RELAXED ?? '').trim().toLowerCase() === 'true';

/** True only inside a sandbox daemon that opted into the relaxed execute posture (env-gated). The host
 * never sets the flag, so this is always false there — host behavior is unchanged. */
export function relaxedSandboxGuard(): boolean {
  return SANDBOX_GUARD_RELAXED;
}
