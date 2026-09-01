import { describe, expect, it } from 'bun:test'

import {
  HOOK_CONTEXT_KEY,
  hookOutcomeDrafts,
  PLAN_TOOL_NAME,
  toCallId,
  toThreadId,
  EToolEffect,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { MirrorPlanHook } from '../mirror-plan'

const NEVER_ABORTED = new AbortController().signal

const hook = new MirrorPlanHook()

const callOf = (args: { name: string; input: unknown }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: EToolEffect.Read,
  threadId: toThreadId('thread-1'),
})

const OK: ToolOutcome = { ok: true, output: {}, modelText: 'ok' }

const PLAN = { tasks: [{ text: 'Wire the composer', status: 'in_progress' }] }

describe('MirrorPlanHook', () => {
  it('mirrors a written plan into context so it survives compaction', async () => {
    const outcome = await hook.run({ call: callOf({ name: PLAN_TOOL_NAME, input: PLAN }), result: OK, signal: NEVER_ABORTED })

    expect(outcome.additionalContext).toContain('#1 [in_progress] Wire the composer')
  })

  it('keys the mirror on one slot, so only the newest plan is ever in the prompt', async () => {
    const outcome = await hook.run({ call: callOf({ name: PLAN_TOOL_NAME, input: PLAN }), result: OK, signal: NEVER_ABORTED })

    expect(hookOutcomeDrafts({ hookName: hook.name, outcome })).toMatchObject([
      { type: 'context-loaded', slot: 'plan', key: HOOK_CONTEXT_KEY },
    ])
  })

  it('says the plan is empty rather than leaving a stale one standing', async () => {
    const outcome = await hook.run({
      call: callOf({ name: PLAN_TOOL_NAME, input: { tasks: [] } }),
      result: OK, signal: NEVER_ABORTED })

    expect(outcome.additionalContext).toContain('no plan written')
  })

  it('ignores every other tool', async () => {
    const outcome = await hook.run({ call: callOf({ name: 'read', input: PLAN }), result: OK, signal: NEVER_ABORTED })

    expect(outcome).toEqual({})
  })

  it('ignores a write that failed', async () => {
    const outcome = await hook.run({
      call: callOf({ name: PLAN_TOOL_NAME, input: PLAN }),
      result: { ok: false, reason: 'no' }, signal: NEVER_ABORTED })

    expect(outcome).toEqual({})
  })

  it('ignores input it cannot parse as a plan', async () => {
    const outcome = await hook.run({
      call: callOf({ name: PLAN_TOOL_NAME, input: { tasks: 'nope' } }),
      result: OK, signal: NEVER_ABORTED })

    expect(outcome).toEqual({})
  })
})
