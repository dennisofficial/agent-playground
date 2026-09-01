import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  BeforeToolHook,
  BeforeTurnHook,
  EBeforeToolDecision,
  EContentAccess,
  EPathForm,
  EPathPresence,
  EStage,
  EToolEffect,
  HOOK_CONTEXT_KEY,
  OnChunkHook,
  toThreadId,
  toCallId,
  toRunId,
  ToolDefinition,
  type Assembled,
  type BeforeTool,
  type Chunk,
  type HookOrder,
  type OnChunk,
  type ProviderPrompt,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken, type DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { HookedToolDispatcher } from '../../tools/dispatch'
import { InMemoryToolRegistry } from '../../tools/registry'
import { resolveHookChain } from '../resolve-hooks'

const SESSION_DIRECTORY = '/workspace'

class ChunkHook extends OnChunkHook {
  constructor(
    readonly name: string,
    readonly order: HookOrder,
    readonly run: OnChunk,
  ) {
    super()
  }
}

const observing = (args: { name: string; order: HookOrder; seen: string[] }): ChunkHook =>
  new ChunkHook(args.name, args.order, async (chunk) => {
    args.seen.push(args.name)
    return chunk
  })

const dropping = (args: { name: string; order: HookOrder }): ChunkHook =>
  new ChunkHook(args.name, args.order, async () => null)

function containerWith(hooks: readonly OnChunkHook[]): DependencyContainer {
  const child = createIsolatedContainer()
  for (const hook of hooks) child.register(portToken(OnChunkHook), { useValue: hook })
  return child
}

const guard = (nudge: number): HookOrder => ({ stage: EStage.Guard, nudge })
const observe = (nudge: number): HookOrder => ({ stage: EStage.Observe, nudge })

const text: Chunk = { type: 'text-delta', id: 'block-1', text: 'hello' }

async function namesRun(args: { hooks: readonly OnChunkHook[]; seen: string[] }): Promise<string[]> {
  await resolveHookChain({ container: containerWith(args.hooks) }).onChunk({ chunk: text })
  return args.seen
}

describe('resolveHookChain', () => {
  it('gives the same order whichever way round the two hooks are registered', async () => {
    const runWith = async (reversed: boolean) => {
      const seen: string[] = []
      const redaction = observing({ name: 'secret-redaction', order: guard(0), seen })
      const transcript = observing({ name: 'transcript-log', order: observe(0), seen })
      const hooks = reversed ? [transcript, redaction] : [redaction, transcript]
      return namesRun({ hooks, seen })
    }

    expect(await runWith(false)).toEqual(['secret-redaction', 'transcript-log'])
    expect(await runWith(true)).toEqual(['secret-redaction', 'transcript-log'])
  })

  it('breaks a tie on name, so registration order cannot decide it', async () => {
    const runWith = async (reversed: boolean) => {
      const seen: string[] = []
      const zebra = observing({ name: 'zebra', order: guard(50), seen })
      const alpha = observing({ name: 'alpha', order: guard(50), seen })
      const hooks = reversed ? [alpha, zebra] : [zebra, alpha]
      return namesRun({ hooks, seen })
    }

    expect(await runWith(false)).toEqual(['alpha', 'zebra'])
    expect(await runWith(true)).toEqual(['alpha', 'zebra'])
  })

  it('drops the chunk before the logger runs, registered either way round', async () => {
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'sk-secret' }

    const runWith = async (order: 'redaction-first' | 'logger-first') => {
      const seen: string[] = []
      const redaction = dropping({ name: 'secret-redaction', order: guard(0) })
      const transcript = observing({ name: 'transcript-log', order: observe(0), seen })
      const hooks = order === 'redaction-first' ? [redaction, transcript] : [transcript, redaction]

      const chain = resolveHookChain({ container: containerWith(hooks) })
      const kept = await chain.onChunk({ chunk: delta })

      return { kept, seen }
    }

    expect(await runWith('redaction-first')).toEqual({ kept: null, seen: [] })
    expect(await runWith('logger-first')).toEqual({ kept: null, seen: [] })
  })

  it('resolves a phase nobody registered as empty, not as one phantom hook', async () => {
    const chain = resolveHookChain({ container: createIsolatedContainer() })
    const assembled: Assembled = { system: [], messages: [] }
    const prompt: ProviderPrompt = {
      instructions: [],
      messages: [],
      provider: { id: 'test', modelId: 'test' },
    }

    expect(chain.beforeTool).toEqual([])
    expect(chain.afterTool).toEqual([])
    expect(await chain.beforeStep({ assembled, trace: [] })).toBe(assembled)
    expect(await chain.beforeRequest({ prompt })).toBe(prompt)
    expect(await chain.onChunk({ chunk: text })).toBe(text)
    expect(
      await chain.beforeTurn({ threadId: toThreadId('thread-1'), projectDirectory: '/repo' }),
    ).toEqual([])
    expect(await chain.afterTurn({ threadId: toThreadId('thread-1') })).toEqual([])
  })

  it('resolves a registered BeforeTurnHook and slots its context under the name it declares', async () => {
    class GitStateHook extends BeforeTurnHook {
      readonly name = 'gitState'
      readonly order: HookOrder = { stage: EStage.Observe, nudge: 0 }
      readonly run = async (): Promise<{ additionalContext: string }> => ({
        additionalContext: '3 files dirty',
      })
    }

    const child = createIsolatedContainer()
    child.register(portToken(BeforeTurnHook), { useClass: GitStateHook })

    const chain = resolveHookChain({ container: child })

    expect(
      await chain.beforeTurn({ threadId: toThreadId('thread-1'), projectDirectory: '/repo' }),
    ).toEqual([
      { type: 'context-loaded', slot: 'gitState', key: HOOK_CONTEXT_KEY, content: '3 files dirty' },
    ])
  })
})

let real = ''
let link = ''

beforeAll(async () => {
  real = await mkdtemp(join(tmpdir(), 'atlas-hooks-real-'))
  link = join(await mkdtemp(join(tmpdir(), 'atlas-hooks-link-')), 'workspace')
  await symlink(real, link)
})

const pathOf = (input: unknown): string => z.object({ path: z.string() }).parse(input).path

class PathWitness extends BeforeToolHook {
  readonly name = 'pathWitness'
  readonly order: HookOrder = { stage: EStage.Policy, nudge: 0 }
  readonly seen: string[] = []

  readonly run: BeforeTool = async ({ call }) => {
    this.seen.push(pathOf(call.input))
    return { decision: EBeforeToolDecision.Allow, input: call.input }
  }
}

function touchTool(invoked: string[]): ToolDefinition {
  return {
    name: 'touch',
    description: 'the touch tool',
    effect: EToolEffect.Write,
    inputSchema: z.object({ path: z.string() }),
    pathFields: [
      { field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute, content: EContentAccess.Overwrites },
    ],
    invoke: async ({ input }) => {
      invoked.push(pathOf(input))
      return { ok: true, output: 'touched', modelText: 'touched' }
    },
  }
}
