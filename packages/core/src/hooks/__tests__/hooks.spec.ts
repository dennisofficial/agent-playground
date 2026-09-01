import { describe, expect, it } from 'bun:test'

import { toThreadId, toCallId } from '../../events/ids'
import { EBeforeToolDecision } from '../../policy/before-tool'
import type { Chunk } from '../../stream/chunk'
import { EToolEffect, type ToolCall } from '../../tools/tool'
import type { AfterTool, AfterTurn, BeforeTool, BeforeTurn, OnChunk } from '../hooks'

const call: ToolCall = {
  callId: toCallId('call-1'),
  name: 'write_file',
  input: { path: '/etc/hosts' },
  effect: EToolEffect.Write,
  threadId: toThreadId('thread-1'),
}

const beyondTheCall = {
  projectDirectory: '/w',
  events: [],
  signal: new AbortController().signal,
}

describe('hook types', () => {
  it('let a guard deny a call with a reason', async () => {
    const denyOutsideWorkspace: BeforeTool = async ({ call: candidate }) =>
      candidate.effect === EToolEffect.Read
        ? { decision: EBeforeToolDecision.Allow, input: candidate.input }
        : { decision: EBeforeToolDecision.Deny, reason: 'outside workspace' }

    expect(await denyOutsideWorkspace({ call, ...beyondTheCall })).toEqual({
      decision: EBeforeToolDecision.Deny,
      reason: 'outside workspace',
    })
  })

  it('let a guard rewrite the input it allows', async () => {
    const normalisePath: BeforeTool = async () => ({
      decision: EBeforeToolDecision.Allow,
      input: { path: '/private/var' },
    })

    expect(await normalisePath({ call, ...beyondTheCall })).toEqual({
      decision: EBeforeToolDecision.Allow,
      input: { path: '/private/var' },
    })
  })

  it('let an after-tool hook return drafts rather than stamped events', async () => {
    const loadNeighbouringContext: AfterTool = async ({ call: candidate }) => ({
      drafts: [{ type: 'context-loaded', slot: 'claude-md', key: candidate.name, content: '# rules' }],
    })

    expect(await loadNeighbouringContext({ call, result: { ok: true, output: 'written', modelText: 'written' } })).toEqual({
      drafts: [{ type: 'context-loaded', slot: 'claude-md', key: 'write_file', content: '# rules' }],
    })
  })

  it('let an after-tool hook hand the model text without naming an event at all', async () => {
    const remindAboutTests: AfterTool = async () => ({ additionalContext: 'run bun test' })

    expect(await remindAboutTests({ call, result: { ok: true, output: 'written', modelText: 'written' } })).toEqual({
      additionalContext: 'run bun test',
    })
  })

  it('let an after-turn hook return drafts for a thread', async () => {
    const summarise: AfterTurn = async () => ({
      drafts: [{ type: 'nudge', text: 'keep going', lifetimeSteps: 1 }],
    })

    expect(await summarise({ threadId: toThreadId('thread-1') })).toEqual({
      drafts: [{ type: 'nudge', text: 'keep going', lifetimeSteps: 1 }],
    })
  })

  it('let a before-turn hook open the turn with context and drafts together', async () => {
    const openWithGitState: BeforeTurn = async () => ({
      additionalContext: 'branch: main, 3 files dirty',
      drafts: [{ type: 'nudge', text: 'commit first', lifetimeSteps: 1 }],
    })

    const opening = await openWithGitState({
      threadId: toThreadId('thread-1'),
      projectDirectory: '/repo',
    })

    expect(opening).toEqual({
      additionalContext: 'branch: main, 3 files dirty',
      drafts: [{ type: 'nudge', text: 'commit first', lifetimeSteps: 1 }],
    })
  })

  it('let a hook that has nothing to say return an empty outcome', async () => {
    const quiet: BeforeTurn = async () => ({})

    expect(await quiet({ threadId: toThreadId('thread-1'), projectDirectory: '/repo' })).toEqual(
      {},
    )
  })

  it('let an on-chunk hook drop a chunk entirely', async () => {
    const redact: OnChunk = async (chunk) => (chunk.type === 'text-delta' ? null : chunk)
    const delta: Chunk = { type: 'text-delta', id: 'block-1', text: 'sk-secret' }

    expect(await redact(delta)).toBeNull()
  })
})
