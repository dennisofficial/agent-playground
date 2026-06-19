import type { SandboxRegistry } from './sandbox-registry';
import type { WorkspaceGitPort } from './workspace-git.port';
import type { WorkspaceGitProvider } from './workspace-git.provider';

/**
 * TEST HELPER (Phase 9): a `SandboxRegistry` stand-in for consumer specs that only need the routing
 * discriminator. `has()` defaults to FALSE — the local (non-containerized) path every existing consumer
 * spec exercises, matching the flag-off default. Pass a set of containerized ids to flip specific
 * workspaces on.
 */
export function fakeSandboxRegistry(
  containerizedIds: ReadonlySet<string> = new Set(),
): SandboxRegistry {
  return {
    has: (id: string) => containerizedIds.has(id),
  } as unknown as SandboxRegistry;
}

/**
 * TEST HELPER: a `WorkspaceGitProvider` stand-in whose `resolve()` / `resolveReferenceTarget()` always
 * return the given git surface, so a consumer spec can assert the underlying git method was called
 * without standing up the real daemon-routing machinery. Pass any object implementing the async-git
 * methods under test as `git`; the consumer's `this.workspaceGit.resolve(ctx).<method>(...)` (or
 * `resolveReferenceTarget(...).port.<method>(...)`) calls land straight on it.
 *
 * It collapses the daemon-adapter hop the mock already stands in for. Use `containerizedIds` to model the
 * containerized fork (review/ship/open_pr) and `referenceTarget: false` to model "no live workstation".
 */
export function localGitProvider(
  git: Partial<WorkspaceGitPort> = {},
  opts: {
    /** Work-area ids to treat as containerized (`isContainerized`/`daemonFor` fire for them). */
    containerizedIds?: ReadonlySet<string>;
    /** The object `daemonFor` returns for a containerized ctx (defaults to `git`). */
    daemon?: unknown;
    /** Set false to model "no live workstation to clone into" (`resolveReferenceTarget` → undefined),
     * exercising the reference tools' create_workspace-guidance path. Defaults to a resolved target. */
    referenceTarget?: boolean;
  } = {},
): WorkspaceGitProvider {
  const containerized = opts.containerizedIds ?? new Set<string>();
  const idOf = (ctx?: {
    workspaceId?: string;
    session?: { workspaceId?: string };
  }): string | undefined => ctx?.session?.workspaceId ?? ctx?.workspaceId;
  const isC = (ctx?: {
    workspaceId?: string;
    session?: { workspaceId?: string };
  }): boolean => {
    const id = idOf(ctx);
    return !!id && containerized.has(id);
  };
  return {
    resolve: () => git as WorkspaceGitPort,
    // Default: every consumer fork takes its LOCAL branch (no containerized ids). Pass `containerizedIds`
    // to exercise the daemon path; the call-site forks (review/ship/open_pr/attachDesign) read these.
    isContainerized: isC,
    daemonFor: (ctx?: { workspaceId?: string; session?: { workspaceId?: string } }) =>
      isC(ctx) ? ((opts.daemon ?? git) as never) : undefined,
    // The reference-clone routing seam: returns the given git surface as the resolved workstation port
    // (mirrors `resolve`), or `undefined` when `referenceTarget === false` (no live workstation).
    resolveReferenceTarget: (sel?: { workspaceId?: string }) =>
      opts.referenceTarget === false
        ? undefined
        : { workspaceId: sel?.workspaceId ?? 'wa-ref', port: git as WorkspaceGitPort },
  } as unknown as WorkspaceGitProvider;
}
