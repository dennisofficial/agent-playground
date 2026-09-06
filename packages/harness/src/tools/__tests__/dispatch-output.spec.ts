import { describe, expect, it } from 'bun:test'

import type { ToolOutputChunk } from '@dltech/atlas-core'

import { HookChain } from '../../hooks/registry'
import { EApprovalRouting, HookedToolDispatcher } from '../dispatch'
import { InMemoryToolRegistry } from '../registry'
import { readCall, toolNamed } from './fixtures'

const dispatcherWith = (
  invoke: (invocation: { onOutput?: ((chunk: ToolOutputChunk) => void) | undefined }) => Promise<{
    ok: true
    output: unknown
    modelText: string
  }>,
): HookedToolDispatcher =>
  new HookedToolDispatcher({
    approvals: EApprovalRouting.Operator,
    registry: new InMemoryToolRegistry([toolNamed({ name: 'read', invoke })]),
    hooks: new HookChain({}),
  })

describe('a call that carries an output listener', () => {
  it('reaches the tool invocation, so what the tool prints streams back through it', async () => {
    const chunks: ToolOutputChunk[] = []
    const dispatcher = dispatcherWith(async (invocation) => {
      invocation.onOutput?.({ stream: 'stdout', text: 'half\n' })
      invocation.onOutput?.({ stream: 'stderr', text: 'warn\n' })
      return { ok: true, output: 'done', modelText: 'rendered' }
    })

    const drafts = await dispatcher.dispatch({
      call: readCall,
      signal: new AbortController().signal,
      projectDirectory: '/workspace',
      events: [],
      onOutput: (chunk) => chunks.push(chunk),
    })

    expect(chunks).toEqual([
      { stream: 'stdout', text: 'half\n' },
      { stream: 'stderr', text: 'warn\n' },
    ])
    expect(drafts[0]?.type).toBe('tool-result')
  })

  it('invokes the tool without one when the call carried none', async () => {
    let seen: unknown = 'untouched'
    const dispatcher = dispatcherWith(async (invocation) => {
      seen = invocation.onOutput
      return { ok: true, output: 'done', modelText: 'rendered' }
    })

    await dispatcher.dispatch({
      call: readCall,
      signal: new AbortController().signal,
      projectDirectory: '/workspace',
      events: [],
    })

    expect(seen).toBeUndefined()
  })
})
