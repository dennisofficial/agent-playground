import { describe, expect, it } from 'bun:test'

import { EDecision } from '../../events/body'
import { toCallId } from '../../events/ids'
import { log } from '../../assembly/__tests__/log-fixture'
import { planFromEvents } from '../from-events'
import { EPlanStatus, PLAN_TOOL_NAME } from '../plan'

const CALL_ONE = toCallId('call-1')

const CALL_TWO = toCallId('call-2')

const wrote = (args: { callId: string; tasks: readonly unknown[] }) =>
  ({
    type: 'tool-called',
    callId: toCallId(args.callId),
    name: PLAN_TOOL_NAME,
    input: { tasks: args.tasks },
    ordinal: 0,
  }) as const

const settled = (callId: string) =>
  ({ type: 'tool-result', callId: toCallId(callId), name: PLAN_TOOL_NAME, output: 'ok' }) as const

describe('the plan folded out of the log', () => {
  it('is empty on a thread that never wrote one', () => {
    expect(planFromEvents(log([{ type: 'user-said', text: 'hello' }]))).toEqual([])
  })

  it('is the tasks of the settled write', () => {
    const events = log([
      wrote({ callId: 'call-1', tasks: [{ text: 'read the code' }] }),
      settled('call-1'),
    ])

    expect(planFromEvents(events)).toEqual([
      { ordinal: 1, text: 'read the code', status: EPlanStatus.Pending },
    ])
  })

  it('takes the newest write, because a plan is replaced rather than appended', () => {
    const events = log([
      wrote({ callId: 'call-1', tasks: [{ text: 'old' }] }),
      settled('call-1'),
      wrote({
        callId: 'call-2',
        tasks: [{ text: 'old', status: EPlanStatus.Completed }, { text: 'new' }],
      }),
      settled('call-2'),
    ])

    expect(planFromEvents(events).map((task) => [task.text, task.status])).toEqual([
      ['old', EPlanStatus.Completed],
      ['new', EPlanStatus.Pending],
    ])
  })

  it('ignores a write that has not settled yet', () => {
    const events = log([wrote({ callId: 'call-1', tasks: [{ text: 'in flight' }] })])

    expect(planFromEvents(events)).toEqual([])
  })

  it('ignores a write whose result was an error', () => {
    const events = log([
      wrote({ callId: 'call-1', tasks: [{ text: 'failed' }] }),
      {
        type: 'tool-result',
        callId: CALL_ONE,
        name: PLAN_TOOL_NAME,
        error: { message: 'no' },
      },
    ])

    expect(planFromEvents(events)).toEqual([])
  })

  it('falls back to the last write it can parse', () => {
    const events = log([
      wrote({ callId: 'call-1', tasks: [{ text: 'good' }] }),
      settled('call-1'),
      wrote({ callId: 'call-2', tasks: [{ nonsense: true }] }),
      settled('call-2'),
    ])

    expect(planFromEvents(events).map((task) => task.text)).toEqual(['good'])
  })

  it('ignores a call of some other tool', () => {
    const events = log([
      { type: 'tool-called', callId: CALL_TWO, name: 'read', input: { tasks: [] }, ordinal: 0 },
      { type: 'tool-result', callId: CALL_TWO, name: 'read', output: 'ok' },
    ])

    expect(planFromEvents(events)).toEqual([])
  })

  it('honours input the developer edited at the approval', () => {
    const events = log([
      wrote({ callId: 'call-1', tasks: [{ text: 'as written' }] }),
      {
        type: 'approval-answered',
        callId: CALL_ONE,
        decision: EDecision.Allow,
        editedInput: { tasks: [{ text: 'as edited' }] },
      },
      settled('call-1'),
    ])

    expect(planFromEvents(events).map((task) => task.text)).toEqual(['as edited'])
  })
})
