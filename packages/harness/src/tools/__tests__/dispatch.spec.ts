import { describe, expect, it } from 'bun:test'

import { z } from 'zod'

import {
  EBeforeToolDecision,
  EStage,
  EToolEffect,
  toCallId,
  type BeforeTool,
  type ToolCall,
  type ToolDefinition,
  type ToolInvocation,
} from '@dltech/atlas-core'

import { createHookRegistry } from '../../hooks/registry'
import { createDispatch } from '../dispatch'
import { createToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

describe('dispatching a call for a tool nobody registered', () => {
  it('answers the model with an error result naming the tool and what is available', async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([toolNamed({ name: 'glob', invoke: async () => ({ ok: true, output: '', modelText: 'rendered' }) })]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('read')
    expect(message).toContain('glob')
  })
})

describe('dispatching a call no hook objects to', () => {
  it('invokes the tool and reports its output, keyed by the run that emitted the call', async () => {
    const invocations: ToolInvocation[] = []
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async (invocation) => {
            invocations.push(invocation)
            return { ok: true, output: '1\tconst a = 1', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: '1\tconst a = 1',
        modelText: 'rendered',
      },
    ])
    expect(invocations.map((invocation) => invocation.idempotencyKey)).toEqual(['run-1:call-1'])
    expect(invocations[0]?.input).toEqual({ path: 'a.ts' })
  })
})

describe('dispatching a call the tool itself cannot complete', () => {
  it('renders a refused invocation as an error result the model can read', async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: false, reason: 'a.ts does not exist' }) }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: undefined,
        error: { message: 'a.ts does not exist' },
      },
    ])
  })

  it('survives a tool that throws rather than letting it kill the turn', async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            throw new Error('EMFILE: too many open files')
          },
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toHaveLength(1)
    const error = drafts[0]?.type === 'tool-result' ? drafts[0].error?.message : undefined
    expect(error).toContain('EMFILE: too many open files')
  })
})

describe('the two projections of a successful result', () => {
  it("carries the tool's model-facing text onto the draft", async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => ({
            ok: true,
            output: { path: 'a.ts', lines: 1, patch: '@@ -1 +1 @@' },
            modelText: 'The file a.ts has been updated successfully.',
          }),
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts).toEqual([
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: { path: 'a.ts', lines: 1, patch: '@@ -1 +1 @@' },
        modelText: 'The file a.ts has been updated successfully.',
      },
    ])
  })

  it('leaves an empty model-facing text empty rather than deciding what the model reads', async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: true, output: 'contents', modelText: '' }) }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts[0]?.type === 'tool-result' ? drafts[0].modelText : 'absent').toBe('')
  })

  it('leaves the model-facing text off a failure, whose voice is the error', async () => {
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({ name: 'read', invoke: async () => ({ ok: false, reason: 'a.ts does not exist' }) }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({ call: readCall, signal: new AbortController().signal })

    expect(drafts[0]?.type === 'tool-result' ? drafts[0].modelText : 'present').toBeUndefined()
  })
})

describe('dispatching a call whose input the tool schema rejects', () => {
  it('answers with an error result and never invokes the tool', async () => {
    let invoked = false
    const dispatch = createDispatch({
      registry: createToolRegistry([
        toolNamed({
          name: 'read',
          invoke: async () => {
            invoked = true
            return { ok: true, output: '', modelText: 'rendered' }
          },
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({
      call: { ...readCall, input: {} },
      signal: new AbortController().signal,
    })

    expect(invoked).toBe(false)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.type).toBe('tool-result')
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('read')
    expect(message).toContain('path')
  })
})

const strictReadTool = (args: {
  invoke: (invocation: ToolInvocation) => Promise<{ ok: true; output: unknown; modelText: string }>
}): ToolDefinition => ({
  name: 'read',
  description: 'the read tool',
  effect: EToolEffect.Read,
  inputSchema: z.strictObject({ path: z.string(), limit: z.number().default(50) }),
  invoke: args.invoke,
})

const succeeds = async () => ({ ok: true as const, output: '', modelText: 'rendered' })

describe('dispatching a call carrying a key the tool never declared', () => {
  it('rejects it rather than quietly ignoring it, as strictObject asks', async () => {
    let invoked = false
    const dispatch = createDispatch({
      registry: createToolRegistry([
        strictReadTool({
          invoke: async () => {
            invoked = true
            return succeeds()
          },
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    const drafts = await dispatch({
      call: { ...readCall, input: { path: 'a.ts', sudo: true } },
      signal: new AbortController().signal,
    })

    expect(invoked).toBe(false)
    const message = drafts[0]?.type === 'tool-result' ? (drafts[0].error?.message ?? '') : ''
    expect(message).toContain('sudo')
  })
})

describe('dispatching a call the schema accepts and completes', () => {
  it('hands the tool the parsed input, not the raw input the model sent', async () => {
    const invocations: ToolInvocation[] = []
    const dispatch = createDispatch({
      registry: createToolRegistry([
        strictReadTool({
          invoke: async (invocation) => {
            invocations.push(invocation)
            return succeeds()
          },
        }),
      ]),
      hooks: createHookRegistry({}),
    })

    await dispatch({ call: { ...readCall, input: { path: 'a.ts' } }, signal: new AbortController().signal })

    expect(invocations[0]?.input).toEqual({ path: 'a.ts', limit: 50 })
  })

  it('shows a before-tool hook the parsed input, so a guard need not do input archaeology', async () => {
    const seen: unknown[] = []
    const watching: BeforeTool = async ({ call }: { call: ToolCall }) => {
      seen.push(call.input)
      return { decision: EBeforeToolDecision.Allow, input: call.input }
    }

    const dispatch = createDispatch({
      registry: createToolRegistry([strictReadTool({ invoke: succeeds })]),
      hooks: createHookRegistry({
        beforeTool: [{ name: 'watcher', order: { stage: EStage.Guard, nudge: 0 }, run: watching }],
      }),
    })

    await dispatch({ call: { ...readCall, input: { path: 'a.ts' } }, signal: new AbortController().signal })

    expect(seen).toEqual([{ path: 'a.ts', limit: 50 }])
  })
})
