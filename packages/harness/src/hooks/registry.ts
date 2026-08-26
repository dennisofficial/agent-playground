import { orderHooks, type AfterTool, type BeforeTool, type HookOrder } from '@dltech/atlas-core'

export type RegisteredHook<TPhase> = { name: string; order: HookOrder; run: TPhase }

export type HookRegistry = {
  beforeTool: readonly RegisteredHook<BeforeTool>[]
  afterTool: readonly RegisteredHook<AfterTool>[]
}

export function createHookRegistry(args: {
  beforeTool?: readonly RegisteredHook<BeforeTool>[] | undefined
  afterTool?: readonly RegisteredHook<AfterTool>[] | undefined
}): HookRegistry {
  return {
    beforeTool: orderHooks(args.beforeTool ?? []),
    afterTool: orderHooks(args.afterTool ?? []),
  }
}
