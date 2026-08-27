import {
  AfterToolHook,
  AfterTurnHook,
  BeforeRequestHook,
  BeforeStepHook,
  BeforeToolHook,
  OnChunkHook,
} from '@dltech/atlas-core'

import { portToken, type DependencyContainer, type PortConstructor } from '../container/injection'
import { createHookRegistry, type HookRegistry } from './registry'

// tsyringe's `resolveAll` only treats an unregistered token as empty when it is a string or symbol
// (`isNormalToken`); an unregistered *class* token falls through to `construct(token)`, and since
// TypeScript erases `abstract`, that yields one phantom instance with no name, order or run rather
// than an error. `{ isOptional: true }` does not cover it either.
// https://github.com/microsoft/tsyringe/blob/master/src/dependency-container.ts
function hooksOf<THook>(args: {
  container: DependencyContainer
  phase: PortConstructor<THook>
}): readonly THook[] {
  const token = portToken(args.phase)
  if (!args.container.isRegistered(token, true)) return []
  return args.container.resolveAll(token)
}

export function resolveHookRegistry(args: { container: DependencyContainer }): HookRegistry {
  const registered = <THook>(phase: PortConstructor<THook>): readonly THook[] =>
    hooksOf({ container: args.container, phase })

  return createHookRegistry({
    beforeStep: registered(BeforeStepHook),
    beforeRequest: registered(BeforeRequestHook),
    beforeTool: registered(BeforeToolHook),
    afterTool: registered(AfterToolHook),
    onChunk: registered(OnChunkHook),
    afterTurn: registered(AfterTurnHook),
  })
}
