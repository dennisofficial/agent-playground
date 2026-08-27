import { AfterToolHook, BeforeToolHook } from '@dltech/atlas-core'

import { portToken, type DependencyContainer } from '../container/injection'
import { WorkspaceBoundaryHook } from './boundary'
import { ReadBeforeWriteHook } from './read-before-write'
import { RecordFileStateHook } from './record-file-state'

export function registerBuiltinHooks({ container }: { container: DependencyContainer }): void {
  container.register(portToken(BeforeToolHook), { useClass: WorkspaceBoundaryHook })
  container.register(portToken(BeforeToolHook), { useClass: ReadBeforeWriteHook })
  container.register(portToken(AfterToolHook), { useClass: RecordFileStateHook })
}
