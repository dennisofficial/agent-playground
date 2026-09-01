import {
  AfterToolHook,
  BeforeToolHook,
  BeforeTurnHook,
  WorkspaceFactsPort,
} from '@dltech/atlas-core'

import { GitWorkspaceFacts } from '../classifier/workspace-facts'
import { instanceCachingFactory, portToken, type DependencyContainer } from '../container/injection'
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

  container.register(portToken(BeforeToolHook), { useClass: ResolveProjectPathsHook })
  container.register(portToken(BeforeToolHook), { useClass: ReadBeforeWriteHook })
  container.register(portToken(BeforeTurnHook), { useClass: PrewarmFactsHook })
  container.register(portToken(AfterToolHook), { useClass: RecordFileStateHook })
  container.register(portToken(AfterToolHook), { useClass: MirrorPlanHook })
  container.register(portToken(AfterToolHook), { useClass: TrackWorktreeHook })
  container.register(portToken(AfterToolHook), { useClass: InvalidateFactsHook })
}
