import {
  hookOutcomeDrafts,
  orderHooks,
  type AfterTool,
  type AfterTurn,
  type Assembled,
  type AssemblyTrace,
  type BeforeRequest,
  type BeforeStep,
  type BeforeTool,
  type BeforeTurn,
  type ThreadId,
  type Chunk,
  type EventDraft,
  type HookOrder,
  type HookOutcome,
  type OnChunk,
  type ProviderPrompt,
} from '@dltech/atlas-core'

export type RegisteredHook<TPhase> = { name: string; order: HookOrder; run: TPhase }

type OutcomeHook<TArgs> = (args: TArgs) => Promise<HookOutcome>

export type HookChainArgs = {
  beforeTurn?: readonly RegisteredHook<BeforeTurn>[] | undefined
  beforeStep?: readonly RegisteredHook<BeforeStep>[] | undefined
  beforeRequest?: readonly RegisteredHook<BeforeRequest>[] | undefined
  beforeTool?: readonly RegisteredHook<BeforeTool>[] | undefined
  afterTool?: readonly RegisteredHook<AfterTool>[] | undefined
  onChunk?: readonly RegisteredHook<OnChunk>[] | undefined
  afterTurn?: readonly RegisteredHook<AfterTurn>[] | undefined
}

async function collectDrafts<TArgs>({
  hooks,
  args,
}: {
  hooks: readonly RegisteredHook<OutcomeHook<TArgs>>[]
  args: TArgs
}): Promise<readonly EventDraft[]> {
  const drafts: EventDraft[] = []

  for (const hook of hooks) {
    const outcome = await hook.run(args)
    drafts.push(...hookOutcomeDrafts({ hookName: hook.name, outcome }))
  }

  return drafts
}

export class HookChain {
  readonly beforeTool: readonly RegisteredHook<BeforeTool>[]
  readonly afterTool: readonly RegisteredHook<AfterTool>[]

  private readonly beforeTurnHooks: readonly RegisteredHook<BeforeTurn>[]
  private readonly beforeStepHooks: readonly RegisteredHook<BeforeStep>[]
  private readonly beforeRequestHooks: readonly RegisteredHook<BeforeRequest>[]
  private readonly onChunkHooks: readonly RegisteredHook<OnChunk>[]
  private readonly afterTurnHooks: readonly RegisteredHook<AfterTurn>[]

  constructor(args: HookChainArgs) {
    this.beforeTurnHooks = orderHooks(args.beforeTurn ?? [])
    this.beforeStepHooks = orderHooks(args.beforeStep ?? [])
    this.beforeRequestHooks = orderHooks(args.beforeRequest ?? [])
    this.beforeTool = orderHooks(args.beforeTool ?? [])
    this.afterTool = orderHooks(args.afterTool ?? [])
    this.onChunkHooks = orderHooks(args.onChunk ?? [])
    this.afterTurnHooks = orderHooks(args.afterTurn ?? [])
  }

  async beforeTurn(args: {
    threadId: ThreadId
    projectDirectory: string
  }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.beforeTurnHooks, args })
  }

  async beforeStep(args: { assembled: Assembled; trace: AssemblyTrace }): Promise<Assembled> {
    let assembled = args.assembled
    for (const hook of this.beforeStepHooks) assembled = await hook.run({ assembled, trace: args.trace })
    return assembled
  }

  async beforeRequest(args: { prompt: ProviderPrompt }): Promise<ProviderPrompt> {
    let prompt = args.prompt
    for (const hook of this.beforeRequestHooks) prompt = await hook.run(prompt)
    return prompt
  }

  async onChunk(args: { chunk: Chunk }): Promise<Chunk | null> {
    let chunk = args.chunk
    for (const hook of this.onChunkHooks) {
      const kept = await hook.run(chunk)
      if (kept === null) return null
      chunk = kept
    }
    return chunk
  }

  async afterTurn(args: { threadId: ThreadId }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.afterTurnHooks, args })
  }
}
