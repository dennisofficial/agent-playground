import {
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  OnChunkHook,
} from '@dltech/atlas-core'

import {
  portToken,
  resolveSet,
  type DependencyContainer,
  type PortConstructor,
} from '../container/injection'
import { createHookRegistry, type HookRegistry } from './registry'

export function resolveHookRegistry(args: { container: DependencyContainer }): HookRegistry {
  const phase = <THook>(hook: PortConstructor<THook>): readonly THook[] =>
    resolveSet({ container: args.container, token: portToken(hook) })

  return createHookRegistry({
    beforeStep: phase(BeforeStepHook),
    beforeRequest: phase(BeforeRequestHook),
    beforeTool: phase(BeforeToolHook),
    afterTool: phase(AfterToolHook),
    onChunk: phase(OnChunkHook),
    afterTurn: phase(AfterTurnHook),
  })
}
