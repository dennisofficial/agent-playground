import type { Assembled } from '../assembly/assembled'
import type { ProviderPrompt } from '../assembly/provider-prompt'
import type { AssemblyTrace } from '../assembly/trace'
import type { ThreadId } from '../events/ids'
import type { BeforeToolOutcome } from '../policy/before-tool'
import type { Chunk } from '../stream/chunk'
import type { ToolCall, ToolOutcome } from '../tools/tool'
import type { HookOrder } from './order'
import type { HookOutcome } from './outcome'

export * from './order'
export * from './outcome'

export enum EHookPhase {
  BeforeTurn = 'before-turn',
  BeforeStep = 'before-step',
  BeforeRequest = 'before-request',
  BeforeTool = 'before-tool',
  AfterTool = 'after-tool',
  OnChunk = 'on-chunk',
  AfterTurn = 'after-turn',
}

export type BeforeTurn = (args: { threadId: ThreadId }) => Promise<HookOutcome>

export type BeforeStep = (args: { assembled: Assembled; trace: AssemblyTrace }) => Promise<Assembled>

export type BeforeRequest = (prompt: ProviderPrompt) => Promise<ProviderPrompt>

export type BeforeTool = (args: { call: ToolCall }) => Promise<BeforeToolOutcome>

export type AfterTool = (args: { call: ToolCall; result: ToolOutcome }) => Promise<HookOutcome>

export type OnChunk = (chunk: Chunk) => Promise<Chunk | null>

export type AfterTurn = (args: { threadId: ThreadId }) => Promise<HookOutcome>

abstract class PhaseHook<TRun> {
  abstract readonly name: string
  abstract readonly order: HookOrder
  abstract readonly run: TRun
}

export abstract class BeforeTurnHook extends PhaseHook<BeforeTurn> {}

export abstract class BeforeStepHook extends PhaseHook<BeforeStep> {}

export abstract class BeforeRequestHook extends PhaseHook<BeforeRequest> {}

export abstract class BeforeToolHook extends PhaseHook<BeforeTool> {}

export abstract class AfterToolHook extends PhaseHook<AfterTool> {}

export abstract class OnChunkHook extends PhaseHook<OnChunk> {}

export abstract class AfterTurnHook extends PhaseHook<AfterTurn> {}
