import {
  AfterToolHook,
  BeforeToolHook,
  BeforeTurnHook,
  ToolDefinition,
  WorkspaceFactsPort,
} from '@dltech/atlas-core'

import { registerClassifier } from '../classifier/register-classifier'
import { GitWorkspaceFacts } from '../classifier/workspace-facts'
import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
import { WorkspaceRoot } from '../container/tokens'
import { FileReadStatePort } from '../files/read-state'
import { InvalidateFactsHook } from './invalidate-facts'
import { MirrorPlanHook } from './mirror-plan'
import { PrewarmFactsHook } from './prewarm-facts'
import { ReadBeforeWriteHook } from './read-before-write'
import { ResolveProjectPathsHook } from './resolve-project-paths'
import { RecordFileStateHook } from './record-file-state'
import { TrackWorktreeHook } from './track-worktree'

export function registerBuiltinHooks({ container }: { container: DependencyContainer }): void {
  container.register(portToken(WorkspaceFactsPort), {
    useFactory: instanceCachingFactory(() => new GitWorkspaceFacts()),
  })

  container.register(portToken(BeforeToolHook), {
    useFactory: (resolver) =>
      new ResolveProjectPathsHook(resolver.resolveAll(portToken(ToolDefinition))),
  })
  container.register(portToken(BeforeToolHook), {
    useFactory: (resolver) =>
      new ReadBeforeWriteHook(
        resolver.resolve(portToken(FileReadStatePort)),
        resolver.resolveAll(portToken(ToolDefinition)),
      ),
  })
  registerClassifier({ container })
  container.register(portToken(BeforeTurnHook), {
    useFactory: (resolver) =>
      new PrewarmFactsHook(
        resolver.resolve(portToken(WorkspaceFactsPort)),
        resolver.resolve(WorkspaceRoot),
      ),
  })
  container.register(portToken(AfterToolHook), {
    useFactory: (resolver) =>
      new RecordFileStateHook(
        resolver.resolve(portToken(FileReadStatePort)),
        resolver.resolveAll(portToken(ToolDefinition)),
      ),
  })
  container.register(portToken(AfterToolHook), { useClass: MirrorPlanHook })
  container.register(portToken(AfterToolHook), { useClass: TrackWorktreeHook })
  container.register(portToken(AfterToolHook), {
    useFactory: (resolver) =>
      new InvalidateFactsHook(resolver.resolve(portToken(WorkspaceFactsPort))),
  })
}
