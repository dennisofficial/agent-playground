import { mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'

import {
  BeforeToolHook,
  EBeforeToolDecision,
  EPathForm,
  EPathPresence,
  EStage,
  EToolEffect,
  OnChunkHook,
  toCallId,
  toRunId,
  ToolDefinition,
  type BeforeTool,
  type Chunk,
  type HookOrder,
  type OnChunk,
} from '@dltech/atlas-core'

import { createIsolatedContainer, portToken, type DependencyContainer } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { createDispatch } from '../../tools/dispatch'
import { createToolRegistry } from '../../tools/registry'
import { WorkspaceBoundaryHook } from '../boundary'
import { runOnChunk } from '../registry'
import { resolveHookRegistry } from '../resolve-hooks'

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

describe('resolveHookRegistry', () => {
  it('gives the same order whichever way round the two hooks are registered', () => {
    const seen: string[] = []
    const redaction = observing({ name: 'secret-redaction', order: guard(0), seen })
    const transcript = observing({ name: 'transcript-log', order: observe(0), seen })

    const forwards = resolveHookRegistry({ container: containerWith([redaction, transcript]) })
    const backwards = resolveHookRegistry({ container: containerWith([transcript, redaction]) })

    expect(forwards.onChunk.map((hook) => hook.name)).toEqual(['secret-redaction', 'transcript-log'])
    expect(backwards.onChunk.map((hook) => hook.name)).toEqual(forwards.onChunk.map((hook) => hook.name))
  })

  it('breaks a tie on name, so registration order cannot decide it', () => {
    const seen: string[] = []
    const zebra = observing({ name: 'zebra', order: guard(50), seen })
    const alpha = observing({ name: 'alpha', order: guard(50), seen })

    const forwards = resolveHookRegistry({ container: containerWith([zebra, alpha]) })
    const backwards = resolveHookRegistry({ container: containerWith([alpha, zebra]) })

    expect(forwards.onChunk.map((hook) => hook.name)).toEqual(['alpha', 'zebra'])
    expect(backwards.onChunk.map((hook) => hook.name)).toEqual(['alpha', 'zebra'])
  })

  it('drops the chunk before the logger runs, registered either way round', async () => {
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'sk-secret' }

    const runWith = async (order: 'redaction-first' | 'logger-first') => {
      const seen: string[] = []
      const redaction = dropping({ name: 'secret-redaction', order: guard(0) })
      const transcript = observing({ name: 'transcript-log', order: observe(0), seen })
      const hooks = order === 'redaction-first' ? [redaction, transcript] : [transcript, redaction]

      const registry = resolveHookRegistry({ container: containerWith(hooks) })
      const kept = await runOnChunk({ hooks: registry.onChunk, chunk: delta })

      return { kept, seen }
    }

    expect(await runWith('redaction-first')).toEqual({ kept: null, seen: [] })
    expect(await runWith('logger-first')).toEqual({ kept: null, seen: [] })
  })

  it('resolves a phase nobody registered as empty, not as one phantom hook', () => {
    const registry = resolveHookRegistry({ container: createIsolatedContainer() })

    expect(registry.beforeStep).toEqual([])
    expect(registry.beforeRequest).toEqual([])
    expect(registry.beforeTool).toEqual([])
    expect(registry.afterTool).toEqual([])
    expect(registry.onChunk).toEqual([])
    expect(registry.afterTurn).toEqual([])
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
    pathFields: [{ field: 'path', presence: EPathPresence.Required, form: EPathForm.Absolute }],
    invoke: async ({ input }) => {
      invoked.push(pathOf(input))
      return { ok: true, output: 'touched', modelText: 'touched' }
    },
  }
}

describe('the boundary hook threaded ahead of a second hook', () => {
  it('hands the next hook the path the caller wrote, not the realpath it checked against', async () => {
    const witness = new PathWitness()
    const invoked: string[] = []
    const touch = touchTool(invoked)

    const child = createIsolatedContainer()
    child.register(WorkspaceRoot, { useValue: link })
    child.register(portToken(ToolDefinition), { useValue: touch })
    child.register(portToken(BeforeToolHook), { useClass: WorkspaceBoundaryHook })
    child.register(portToken(BeforeToolHook), { useValue: witness })

    const dispatch = createDispatch({
      registry: createToolRegistry([touch]),
      hooks: resolveHookRegistry({ container: child }),
    })

    const path = join(link, 'a.ts')
    const drafts = await dispatch({
      call: { callId: toCallId('call-1'), name: 'touch', input: { path }, runId: toRunId('run-1') },
      signal: AbortSignal.timeout(5_000),
    })

    expect(real).not.toBe(link)
    expect(drafts.map((draft) => draft.type)).toEqual(['tool-result'])
    expect(witness.seen).toEqual([path])
    expect(invoked).toEqual([path])
  })

  it('denies a path outside the root the container injected', async () => {
    const invoked: string[] = []
    const touch = touchTool(invoked)

    const child = createIsolatedContainer()
    child.register(WorkspaceRoot, { useValue: link })
    child.register(portToken(ToolDefinition), { useValue: touch })
    child.register(portToken(BeforeToolHook), { useClass: WorkspaceBoundaryHook })

    const dispatch = createDispatch({
      registry: createToolRegistry([touch]),
      hooks: resolveHookRegistry({ container: child }),
    })

    const drafts = await dispatch({
      call: {
        callId: toCallId('call-2'),
        name: 'touch',
        input: { path: '/etc/hosts' },
        runId: toRunId('run-1'),
      },
      signal: AbortSignal.timeout(5_000),
    })

    expect(drafts.map((draft) => draft.type)).toEqual(['tool-denied'])
    expect(invoked).toEqual([])
  })
})
