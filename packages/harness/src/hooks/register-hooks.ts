import { AfterToolHook, BeforeToolHook } from '@dltech/atlas-core'

import { portToken, type DependencyContainer } from '../container/injection'
import { MirrorPlanHook } from './mirror-plan'
import { ReadBeforeWriteHook } from './read-before-write'
import { ResolveProjectPathsHook } from './resolve-project-paths'
import { RecordFileStateHook } from './record-file-state'
import { TrackSessionDirectoryHook } from './track-session-directory'

export function registerBuiltinHooks({ container }: { container: DependencyContainer }): void {
  container.register(portToken(BeforeToolHook), { useClass: ResolveProjectPathsHook })
  container.register(portToken(BeforeToolHook), { useClass: ReadBeforeWriteHook })
  container.register(portToken(AfterToolHook), { useClass: RecordFileStateHook })
  container.register(portToken(AfterToolHook), { useClass: MirrorPlanHook })
  container.register(portToken(AfterToolHook), { useClass: TrackSessionDirectoryHook })
}
