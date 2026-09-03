import {
  hookOutcomeDrafts,
  orderHooks,
  type AfterShell,
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
  type EndedShell,
  type EventDraft,
  type HookOrder,
  type HookOutcome,
  type OnChunk,
  type OnThreadOpen,
  type ProviderPrompt,
} from '@dltech/atlas-core'

import { withinBudget, type OnHookMishap } from './budget'

export type RegisteredHook<TPhase> = { name: string; order: HookOrder; run: TPhase }

/**
 * Anything the chain itself can depend on must hold it as a thunk: the chain resolves hooks, which
 * resolve tools, which resolve the shell registry, and reading it eagerly would close that circle.
 */
export type HookChainSource = () => HookChain

type OutcomeHook<TArgs> = (args: TArgs) => Promise<HookOutcome>

export type HookChainArgs = {
  beforeTurn?: readonly RegisteredHook<BeforeTurn>[] | undefined
  beforeStep?: readonly RegisteredHook<BeforeStep>[] | undefined
  beforeRequest?: readonly RegisteredHook<BeforeRequest>[] | undefined
  beforeTool?: readonly RegisteredHook<BeforeTool>[] | undefined
  afterTool?: readonly RegisteredHook<AfterTool>[] | undefined
  afterShell?: readonly RegisteredHook<AfterShell>[] | undefined
  onChunk?: readonly RegisteredHook<OnChunk>[] | undefined
  afterTurn?: readonly RegisteredHook<AfterTurn>[] | undefined
  onThreadOpen?: readonly RegisteredHook<OnThreadOpen>[] | undefined
  onMishap?: OnHookMishap | undefined
  budgetMs?: number | undefined
}

export type Bounds = { onMishap: OnHookMishap | undefined; budgetMs: number | undefined }

const NOTHING: HookOutcome = {}

function bounded<TValue>(args: {
  hook: { name: string }
  bounds: Bounds
  run: () => Promise<TValue>
  fallback: TValue
}): Promise<TValue> {
  return withinBudget({
    label: args.hook.name,
    run: args.run,
    fallback: () => args.fallback,
    budgetMs: args.bounds.budgetMs,
    onMishap: args.bounds.onMishap,
  })
}

async function collectDrafts<TArgs>({
  hooks,
  args,
  bounds,
}: {
  hooks: readonly RegisteredHook<OutcomeHook<TArgs>>[]
  args: TArgs
  bounds: Bounds
}): Promise<readonly EventDraft[]> {
  const drafts: EventDraft[] = []

  for (const hook of hooks) {
    const outcome = await bounded({
      hook,
      bounds,
      run: () => hook.run(args),
      fallback: NOTHING,
    })
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
  private readonly afterShellHooks: readonly RegisteredHook<AfterShell>[]
  private readonly onChunkHooks: readonly RegisteredHook<OnChunk>[]
  private readonly afterTurnHooks: readonly RegisteredHook<AfterTurn>[]
  private readonly onThreadOpenHooks: readonly RegisteredHook<OnThreadOpen>[]
  readonly bounds: Bounds

  constructor(args: HookChainArgs) {
    this.bounds = { onMishap: args.onMishap, budgetMs: args.budgetMs }
    this.beforeTurnHooks = orderHooks(args.beforeTurn ?? [])
    this.beforeStepHooks = orderHooks(args.beforeStep ?? [])
    this.beforeRequestHooks = orderHooks(args.beforeRequest ?? [])
    this.beforeTool = orderHooks(args.beforeTool ?? [])
    this.afterTool = orderHooks(args.afterTool ?? [])
    this.afterShellHooks = orderHooks(args.afterShell ?? [])
    this.onChunkHooks = orderHooks(args.onChunk ?? [])
    this.afterTurnHooks = orderHooks(args.afterTurn ?? [])
    this.onThreadOpenHooks = orderHooks(args.onThreadOpen ?? [])
  }

  async beforeTurn(args: {
    threadId: ThreadId
    projectDirectory: string
  }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.beforeTurnHooks, args, bounds: this.bounds })
  }

  async onThreadOpen(args: {
    threadId: ThreadId
    projectDirectory: string
  }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.onThreadOpenHooks, args, bounds: this.bounds })
  }

  async beforeStep(args: { assembled: Assembled; trace: AssemblyTrace }): Promise<Assembled> {
    let assembled = args.assembled
    for (const hook of this.beforeStepHooks) {
      const carried = assembled
      assembled = await bounded({
        hook,
        bounds: this.bounds,
        run: () => hook.run({ assembled: carried, trace: args.trace }),
        fallback: carried,
      })
    }
    return assembled
  }

  async beforeRequest(args: { prompt: ProviderPrompt }): Promise<ProviderPrompt> {
    let prompt = args.prompt
    for (const hook of this.beforeRequestHooks) {
      const carried = prompt
      prompt = await bounded({
        hook,
        bounds: this.bounds,
        run: () => hook.run(carried),
        fallback: carried,
      })
    }
    return prompt
  }

  /**
   * No turn is in flight when this runs, so the drafts go back to the shell registry rather than
   * into a log: they are delivered with the ending's notice or not at all.
   */
  async afterShell(args: { threadId: ThreadId; shell: EndedShell }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.afterShellHooks, args, bounds: this.bounds })
  }

  async onChunk(args: { chunk: Chunk }): Promise<Chunk | null> {
    let chunk = args.chunk
    for (const hook of this.onChunkHooks) {
      const carried = chunk
      const kept = await bounded<Chunk | null>({
        hook,
        bounds: this.bounds,
        run: () => hook.run(carried),
        fallback: carried,
      })
      if (kept === null) return null
      chunk = kept
    }
    return chunk
  }

  async afterTurn(args: { threadId: ThreadId }): Promise<readonly EventDraft[]> {
    return collectDrafts({ hooks: this.afterTurnHooks, args, bounds: this.bounds })
  }
}
