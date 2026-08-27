import {
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  BeforeTurnHook,
  OnChunkHook,
} from '@dltech/atlas-core'

import {
  portToken,
  resolveSet,
  type DependencyContainer,
  type PortConstructor,
} from '../container/injection'
import { HookChain } from './registry'

export function resolveHookChain(args: { container: DependencyContainer }): HookChain {
  const phase = <THook>(hook: PortConstructor<THook>): readonly THook[] =>
    resolveSet({ container: args.container, token: portToken(hook) })

  return new HookChain({
    beforeTurn: phase(BeforeTurnHook),
    beforeStep: phase(BeforeStepHook),
    beforeRequest: phase(BeforeRequestHook),
    beforeTool: phase(BeforeToolHook),
    afterTool: phase(AfterToolHook),
    onChunk: phase(OnChunkHook),
    afterTurn: phase(AfterTurnHook),
  })
}
