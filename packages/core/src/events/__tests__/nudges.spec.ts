import { describe, expect, it } from 'bun:test'

import { log } from '../../assembly/__tests__/log-fixture'
import { toCallId } from '../ids'
import { liveNudges } from '../nudges'

const textsOf = (events: readonly { text: string }[]): string[] => events.map((event) => event.text)

describe('liveNudges', () => {
  it('holds a nudge no model step has answered yet', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'partial' }], interrupted: true },
      { type: 'nudge', text: 'carry on', lifetimeSteps: 1 },
    ])

    expect(textsOf(liveNudges(events))).toEqual(['carry on'])
  })

  it('drops a nudge once its lifetime of model steps has passed', () => {
    const events = log([
      { type: 'nudge', text: 'carry on', lifetimeSteps: 1 },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'carried' }] },
    ])

    expect(liveNudges(events)).toEqual([])
  })

  it('counts model steps rather than events, so tool traffic does not expire one', () => {
    const events = log([
      { type: 'nudge', text: 'carry on', lifetimeSteps: 1 },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: {}, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'read', output: 'bytes' },
    ])

    expect(textsOf(liveNudges(events))).toEqual(['carry on'])
  })

  it('lets a longer lifetime outlive one step and expire on the next', () => {
    const drafts = [
      { type: 'nudge' as const, text: 'carry on', lifetimeSteps: 2 },
      { type: 'assistant-said' as const, parts: [{ type: 'text' as const, text: 'one' }] },
    ]

    expect(textsOf(liveNudges(log(drafts)))).toEqual(['carry on'])
    expect(
      liveNudges(
        log([...drafts, { type: 'assistant-said', parts: [{ type: 'text', text: 'two' }] }]),
      ),
    ).toEqual([])
  })

  it('returns nudges in log order', () => {
    const events = log([
      { type: 'nudge', text: 'first', lifetimeSteps: 3 },
      { type: 'nudge', text: 'second', lifetimeSteps: 3 },
    ])

    expect(textsOf(liveNudges(events))).toEqual(['first', 'second'])
  })
})
