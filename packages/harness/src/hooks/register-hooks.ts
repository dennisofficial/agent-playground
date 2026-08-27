import { BeforeToolHook } from '@dltech/atlas-core'

import { portToken, type DependencyContainer } from '../container/injection'
import { WorkspaceBoundaryHook } from './boundary'

export function registerBuiltinHooks({ container }: { container: DependencyContainer }): void {
  container.register(portToken(BeforeToolHook), { useClass: WorkspaceBoundaryHook })
}
