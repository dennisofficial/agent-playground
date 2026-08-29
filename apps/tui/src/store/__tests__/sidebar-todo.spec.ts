import { PLAN_TOOL_NAME, toCallId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { IDLE_TURN } from '../../ui/components/transcript'
import { deriveSidebar, ESidebarTaskState } from '../sidebar-model'
import { log } from './fixture'

const CALL_ONE = toCallId('call-1')

const planWritten = (tasks: readonly unknown[]) =>
  log([
    {
      type: 'tool-called',
      callId: CALL_ONE,
      name: PLAN_TOOL_NAME,
      input: { tasks },
      ordinal: 0,
    },
    { type: 'tool-result', callId: CALL_ONE, name: PLAN_TOOL_NAME, output: 'ok' },
  ])

describe('the sidebar checklist', () => {
  it('is absent before the agent writes a plan, so no bare header is drawn', () => {
    const model = deriveSidebar({ events: log([{ type: 'user-said', text: 'go' }]), turn: IDLE_TURN })

    expect(model.todo).toBeUndefined()
  })

  it('carries every written task in order, with its state', () => {
    const model = deriveSidebar({
      events: planWritten([
        { text: 'Read the code', status: 'completed' },
        { text: 'Wire the composer', status: 'in_progress' },
        { text: 'Ship it' },
      ]),
      turn: IDLE_TURN,
    })

    expect(model.todo).toEqual([
      { id: '1', label: 'Read the code', state: ESidebarTaskState.Done },
      { id: '2', label: 'Wire the composer', state: ESidebarTaskState.Running },
      { id: '3', label: 'Ship it', state: ESidebarTaskState.Pending },
    ])
  })

  it('carries the active form of a task that has one', () => {
    const model = deriveSidebar({
      events: planWritten([
        { text: 'Fix the bug', activeForm: 'Fixing the bug', status: 'in_progress' },
        { text: 'Ship it' },
      ]),
      turn: IDLE_TURN,
    })

    expect(model.todo?.map((task) => task.activeForm)).toEqual(['Fixing the bug', undefined])
  })

  it('disappears when the agent clears its plan', () => {
    expect(deriveSidebar({ events: planWritten([]), turn: IDLE_TURN }).todo).toBeUndefined()
  })
})
