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
 * TEST HELPER (Phase 8): a `WorkspaceGitProvider` stand-in whose `resolve()` always returns the given
 * git surface — the LOCAL path every existing consumer spec asserts. Pass the spec's existing mock
 * `WorkspaceService` (or any object implementing the async-git methods under test) and the consumer's
 * `this.workspaceGit.resolve(ctx).<method>(...)` calls land straight on it, so the spec's assertions
 * (which expect the underlying git method to be called) keep passing unchanged.
 *
 * This mirrors production behavior: `WorkspaceGitProvider.resolve` returns the local pass-through
 * adapter (which delegates 1:1 to `WorkspaceService`) whenever `isContainerized` is false — i.e. always,
 * this phase. The helper collapses the adapter hop the mock service already stands in for.
 */
export function localGitProvider(
  git: Partial<WorkspaceGitPort> = {},
  opts: {
    /** Work-area ids to treat as containerized (`isContainerized`/`daemonFor` fire for them). */
    containerizedIds?: ReadonlySet<string>;
    /** The object `daemonFor` returns for a containerized ctx (defaults to `git`). */
    daemon?: unknown;
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
  } as unknown as WorkspaceGitProvider;
}
