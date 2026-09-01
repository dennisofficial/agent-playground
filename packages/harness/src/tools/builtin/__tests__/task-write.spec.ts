import { describe, expect, it } from 'bun:test'

import { EToolEffect, PLAN_TOOL_NAME,
  toThreadId,
} from '@dltech/atlas-core'

import { TaskWriteTool } from '../task-write'

const SESSION_DIRECTORY = '/workspace'

const write = async (input: unknown) =>
  new TaskWriteTool().invoke({
    input,
    signal: new AbortController().signal,
    idempotencyKey: 'plan-1',
    projectDirectory: SESSION_DIRECTORY,
    threadId: toThreadId('thread-1'),
  })

describe('TaskWriteTool', () => {
  it('is a read: a plan changes nothing on disk', () => {
    expect(new TaskWriteTool().effect).toBe(EToolEffect.Read)
    expect(new TaskWriteTool().name).toBe(PLAN_TOOL_NAME)
  })

  it('answers with the plan rendered for the model to read back', async () => {
    const outcome = await write({
      tasks: [
        { text: 'Read the code', status: 'completed' },
        { text: 'Wire the composer', status: 'in_progress' },
        { text: 'Ship it' },
      ],
    })

    expect(outcome).toMatchObject({ ok: true })
    expect(outcome.ok && outcome.modelText).toBe(
      '#1 [completed] Read the code\n#2 [in_progress] Wire the composer\n#3 [pending] Ship it',
    )
  })

  it('carries an active form back, so the plan round-trips through the model', async () => {
    const outcome = await write({
      tasks: [{ text: 'Fix the bug', activeForm: 'Fixing the bug', status: 'in_progress' }],
    })

    expect(outcome.ok && outcome.modelText).toBe(
      '#1 [in_progress] Fix the bug (active: Fixing the bug)',
    )
  })

  it('clears the plan when handed an empty list', async () => {
    const outcome = await write({ tasks: [] })

    expect(outcome).toMatchObject({ ok: true, output: { tasks: [] } })
  })

  it('refuses a malformed plan with a sentence rather than throwing', async () => {
    const outcome = await write({ tasks: [{ text: 'x', status: 'nearly' }] })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain(PLAN_TOOL_NAME)
  })

  it('refuses a plan that is not a list at all', async () => {
    expect((await write({ tasks: 'do the thing' })).ok).toBe(false)
  })
})
