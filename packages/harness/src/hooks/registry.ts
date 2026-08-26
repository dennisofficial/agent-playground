import {
  orderHooks,
  type AfterTool,
  type AfterTurn,
  type Assembled,
  type BeforeRequest,
  type BeforeStep,
  type BeforeTool,
  type BranchId,
  type Chunk,
  type EventDraft,
  type HookOrder,
  type OnChunk,
  type ProviderPrompt,
} from '@dltech/atlas-core'

export type RegisteredHook<TPhase> = { name: string; order: HookOrder; run: TPhase }

export type HookRegistry = {
  beforeStep: readonly RegisteredHook<BeforeStep>[]
  beforeRequest: readonly RegisteredHook<BeforeRequest>[]
  beforeTool: readonly RegisteredHook<BeforeTool>[]
  afterTool: readonly RegisteredHook<AfterTool>[]
  onChunk: readonly RegisteredHook<OnChunk>[]
  afterTurn: readonly RegisteredHook<AfterTurn>[]
}

export function createHookRegistry(args: {
  beforeStep?: readonly RegisteredHook<BeforeStep>[] | undefined
  beforeRequest?: readonly RegisteredHook<BeforeRequest>[] | undefined
  beforeTool?: readonly RegisteredHook<BeforeTool>[] | undefined
  afterTool?: readonly RegisteredHook<AfterTool>[] | undefined
  onChunk?: readonly RegisteredHook<OnChunk>[] | undefined
  afterTurn?: readonly RegisteredHook<AfterTurn>[] | undefined
}): HookRegistry {
  return {
    beforeStep: orderHooks(args.beforeStep ?? []),
    beforeRequest: orderHooks(args.beforeRequest ?? []),
    beforeTool: orderHooks(args.beforeTool ?? []),
    afterTool: orderHooks(args.afterTool ?? []),
    onChunk: orderHooks(args.onChunk ?? []),
    afterTurn: orderHooks(args.afterTurn ?? []),
  }
}

export async function runBeforeStep(args: {
  hooks: readonly RegisteredHook<BeforeStep>[]
  assembled: Assembled
}): Promise<Assembled> {
  let assembled = args.assembled
  for (const hook of args.hooks) assembled = await hook.run(assembled)
  return assembled
}

export async function runBeforeRequest(args: {
  hooks: readonly RegisteredHook<BeforeRequest>[]
  prompt: ProviderPrompt
}): Promise<ProviderPrompt> {
  let prompt = args.prompt
  for (const hook of args.hooks) prompt = await hook.run(prompt)
  return prompt
}

export async function runOnChunk(args: {
  hooks: readonly RegisteredHook<OnChunk>[]
  chunk: Chunk
}): Promise<Chunk | null> {
  let chunk = args.chunk
  for (const hook of args.hooks) {
    const kept = await hook.run(chunk)
    if (kept === null) return null
    chunk = kept
  }
  return chunk
}

export async function runAfterTurn(args: {
  hooks: readonly RegisteredHook<AfterTurn>[]
  branchId: BranchId
}): Promise<readonly EventDraft[]> {
  const drafts: EventDraft[] = []
  for (const hook of args.hooks) drafts.push(...(await hook.run({ branchId: args.branchId })))
  return drafts
}
