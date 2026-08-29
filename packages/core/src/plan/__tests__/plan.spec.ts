import { describe, expect, it } from 'bun:test'

import {
  EPlanStatus,
  NO_PLAN,
  PLAN_TASK_LIMIT,
  PLAN_TEXT_LIMIT,
  planInputSchema,
  planTasks,
  renderPlan,
} from '../plan'

const tasksOf = (input: unknown): readonly unknown[] => {
  const parsed = planInputSchema.parse(input)
  return planTasks(parsed.tasks)
}

describe('a written plan', () => {
  it('numbers tasks from one in the order they were written', () => {
    expect(tasksOf({ tasks: [{ text: 'first' }, { text: 'second' }] })).toEqual([
      { ordinal: 1, text: 'first', status: EPlanStatus.Pending },
      { ordinal: 2, text: 'second', status: EPlanStatus.Pending },
    ])
  })

  it('defaults an unstated status to pending', () => {
    expect(tasksOf({ tasks: [{ text: 'plain' }] })).toEqual([
      { ordinal: 1, text: 'plain', status: EPlanStatus.Pending },
    ])
  })

  it('rejects an unknown status rather than guessing one', () => {
    expect(planInputSchema.safeParse({ tasks: [{ text: 'x', status: 'nearly' }] }).success).toBe(
      false,
    )
  })

  it('rejects an empty task text', () => {
    expect(planInputSchema.safeParse({ tasks: [{ text: '' }] }).success).toBe(false)
  })

  it('rejects a task longer than a glanceable line', () => {
    const long = 'x'.repeat(PLAN_TEXT_LIMIT + 1)

    expect(planInputSchema.safeParse({ tasks: [{ text: long }] }).success).toBe(false)
  })

  it('rejects a plan longer than the task limit', () => {
    const many = Array.from({ length: PLAN_TASK_LIMIT + 1 }, () => ({ text: 'step' }))

    expect(planInputSchema.safeParse({ tasks: many }).success).toBe(false)
  })

  it('rejects a field the plan does not define', () => {
    expect(planInputSchema.safeParse({ tasks: [{ text: 'x', id: 3 }] }).success).toBe(false)
  })

  it('accepts an empty plan, which is how a finished list is cleared', () => {
    expect(planInputSchema.safeParse({ tasks: [] }).success).toBe(true)
  })
})

describe('rendering a plan for the model to read back', () => {
  it('writes each task as an ordinal, a status and the text', () => {
    const tasks = planTasks([
      { text: 'Wire the composer', status: EPlanStatus.InProgress },
      { text: 'Ship it', status: EPlanStatus.Pending },
    ])

    expect(renderPlan(tasks)).toBe('#1 [in_progress] Wire the composer\n#2 [pending] Ship it')
  })

  it('says so plainly when there is no plan', () => {
    expect(renderPlan([])).toBe(NO_PLAN)
  })

  it('carries the active form, so the model can re-send a plan it cannot see', () => {
    const tasks = planTasks([
      { text: 'Fix the bug', activeForm: 'Fixing the bug', status: EPlanStatus.InProgress },
    ])

    expect(renderPlan(tasks)).toBe('#1 [in_progress] Fix the bug (active: Fixing the bug)')
  })

  it('leaves the active form out of a task that has none', () => {
    expect(renderPlan(planTasks([{ text: 'Ship it', status: EPlanStatus.Pending }]))).toBe(
      '#1 [pending] Ship it',
    )
  })
})

describe('the active form', () => {
  it('is optional', () => {
    expect(planInputSchema.safeParse({ tasks: [{ text: 'Fix the bug' }] }).success).toBe(true)
  })

  it('survives the parse onto the task', () => {
    expect(tasksOf({ tasks: [{ text: 'Fix the bug', activeForm: 'Fixing the bug' }] })).toEqual([
      { ordinal: 1, text: 'Fix the bug', activeForm: 'Fixing the bug', status: EPlanStatus.Pending },
    ])
  })

  it('is held to the same length as the task it names', () => {
    const long = 'x'.repeat(PLAN_TEXT_LIMIT + 1)

    expect(planInputSchema.safeParse({ tasks: [{ text: 'ok', activeForm: long }] }).success).toBe(
      false,
    )
  })

  it('cannot be empty when given', () => {
    expect(planInputSchema.safeParse({ tasks: [{ text: 'ok', activeForm: '' }] }).success).toBe(
      false,
    )
  })
})
