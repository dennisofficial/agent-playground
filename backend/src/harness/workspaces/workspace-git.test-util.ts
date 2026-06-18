import type { WorkspaceService } from './workspace.service';
import type { WorkspaceGitPort } from './workspace-git.port';
import type { WorkspaceGitProvider } from './workspace-git.provider';

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
  git: Partial<WorkspaceGitPort> | WorkspaceService,
): WorkspaceGitProvider {
  return {
    resolve: () => git as WorkspaceGitPort,
  } as unknown as WorkspaceGitProvider;
}
