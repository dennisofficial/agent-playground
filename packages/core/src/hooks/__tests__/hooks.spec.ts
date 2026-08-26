import { describe, expect, it } from 'bun:test'

import { toBranchId, toCallId } from '../../events/ids'
import { EBeforeToolDecision } from '../../policy/before-tool'
import type { Chunk } from '../../stream/chunk'
import { EToolEffect, type ToolCall } from '../../tools/tool'
import type { AfterTool, AfterTurn, BeforeTool, OnChunk } from '../hooks'

const call: ToolCall = {
  callId: toCallId('call-1'),
  name: 'write_file',
  input: { path: '/etc/hosts' },
  effect: EToolEffect.Write,
}

describe('hook types', () => {
  it('let a guard deny a call with a reason', async () => {
    const denyOutsideWorkspace: BeforeTool = async ({ call: candidate }) =>
      candidate.effect === EToolEffect.Read
        ? { decision: EBeforeToolDecision.Allow, input: candidate.input }
        : { decision: EBeforeToolDecision.Deny, reason: 'outside workspace' }

    expect(await denyOutsideWorkspace({ call })).toEqual({
      decision: EBeforeToolDecision.Deny,
      reason: 'outside workspace',
    })
  })

  it('let a guard rewrite the input it allows', async () => {
    const normalisePath: BeforeTool = async () => ({
      decision: EBeforeToolDecision.Allow,
      input: { path: '/private/var' },
    })

    expect(await normalisePath({ call })).toEqual({
      decision: EBeforeToolDecision.Allow,
      input: { path: '/private/var' },
    })
  })

  it('let an after-tool hook return drafts rather than stamped events', async () => {
    const loadNeighbouringContext: AfterTool = async ({ call: candidate }) => [
      { type: 'context-loaded', slot: 'claude-md', key: candidate.name, content: '# rules' },
    ]

    expect(await loadNeighbouringContext({ call, result: { ok: true, output: 'written', modelText: 'written' } })).toEqual([
      { type: 'context-loaded', slot: 'claude-md', key: 'write_file', content: '# rules' },
    ])
  })

  it('let an after-turn hook return drafts for a branch', async () => {
    const summarise: AfterTurn = async () => [{ type: 'nudge', text: 'keep going', lifetimeSteps: 1 }]

    expect(await summarise({ branchId: toBranchId('branch-1') })).toEqual([
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
    ])
  })

  it('let an on-chunk hook drop a chunk entirely', async () => {
    const redact: OnChunk = async (chunk) => (chunk.type === 'text-delta' ? null : chunk)
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'sk-secret' }

    expect(await redact(delta)).toBeNull()
  })
})
