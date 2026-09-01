import {
  AfterShellHook,
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
import { HookMishapReporterToken } from '../container/tokens'
import type { OnHookMishap } from './budget'
import { HookChain } from './registry'

export function resolveHookChain(args: { container: DependencyContainer }): HookChain {
  const phase = <THook>(hook: PortConstructor<THook>): readonly THook[] =>
    resolveSet({ container: args.container, token: portToken(hook) })

  const onMishap: OnHookMishap | undefined = args.container.isRegistered(
    HookMishapReporterToken,
    true,
  )
    ? args.container.resolve(HookMishapReporterToken)
    : undefined

  return new HookChain({
    ...(onMishap === undefined ? {} : { onMishap }),
    beforeTurn: phase(BeforeTurnHook),
    beforeStep: phase(BeforeStepHook),
    beforeRequest: phase(BeforeRequestHook),
    beforeTool: phase(BeforeToolHook),
    afterTool: phase(AfterToolHook),
    afterShell: phase(AfterShellHook),
    onChunk: phase(OnChunkHook),
    afterTurn: phase(AfterTurnHook),
  })
}
