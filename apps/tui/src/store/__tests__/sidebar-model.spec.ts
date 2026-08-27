import { EDecision, toCallId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { IDLE_TURN } from '../../ui/components/transcript'
import { SIDEBAR_WIDTH } from '../../ui/theme'
import { deriveSidebar, IDLE_SIDEBAR } from '../sidebar-model'
import { log } from './fixture'

const CALL_ONE = toCallId('call-1')

const CALL_TWO = toCallId('call-2')

const turnOf = (clock: Partial<typeof IDLE_TURN>): typeof IDLE_TURN => ({ ...IDLE_TURN, ...clock })

describe('an empty thread', () => {
  it('derives an idle sidebar with nothing to show', () => {
    const model = deriveSidebar({ events: [], turn: IDLE_TURN })

    expect(model.approvals).toEqual([])
    expect(model.toolCalls).toEqual([])
    expect(model.lastActivity).toBeNull()
    expect(model.liveOutputTokens).toBe(0)
    expect(model.lastTurnOutputTokens).toBeNull()
  })
})

describe('tool calls', () => {
  it('lists a called tool until its result lands', () => {
    const events = log([
      { type: 'tool-called', callId: CALL_ONE, name: 'read_file', input: {}, ordinal: 0 },
      { type: 'tool-called', callId: CALL_TWO, name: 'list_dir', input: {}, ordinal: 1 },
      { type: 'tool-result', callId: CALL_ONE, name: 'read_file', output: 'ok' },
    ])

    const model = deriveSidebar({ events, turn: IDLE_TURN })

    expect(model.toolCalls.map((call) => [call.callId, call.name])).toEqual([
      [CALL_TWO, 'list_dir'],
    ])
  })
})

describe('approvals', () => {
  it('shows an outstanding approval instead of its tool call', () => {
    const events = log([
      { type: 'tool-called', callId: CALL_ONE, name: 'bash', input: {}, ordinal: 0 },
      { type: 'approval-requested', callId: CALL_ONE, reason: 'runs a shell command' },
    ])

    const model = deriveSidebar({ events, turn: IDLE_TURN })

    expect(model.approvals).toEqual([
      { callId: CALL_ONE, reason: 'runs a shell command' },
    ])
    expect(model.toolCalls).toEqual([])
  })

  it('returns the call to the tool list once the approval is answered', () => {
    const events = log([
      { type: 'tool-called', callId: CALL_ONE, name: 'bash', input: {}, ordinal: 0 },
      { type: 'approval-requested', callId: CALL_ONE, reason: 'runs a shell command' },
      { type: 'approval-answered', callId: CALL_ONE, decision: EDecision.Allow },
    ])

    const model = deriveSidebar({ events, turn: IDLE_TURN })

    expect(model.approvals).toEqual([])
    expect(model.toolCalls.map((call) => call.name)).toEqual(['bash'])
  })
})

describe('turn progress', () => {
  it('counts streamed tokens as live while the turn runs', () => {
    const model = deriveSidebar({
      events: [],
      turn: turnOf({ startedAt: 1000, outputTokens: 120 }),
    })

    expect(model.liveOutputTokens).toBe(120)
    expect(model.lastTurnOutputTokens).toBeNull()
  })

  it('keeps only the completed total once the turn settles', () => {
    const model = deriveSidebar({
      events: [],
      turn: turnOf({ completed: { durationMs: 4000, outputTokens: 300 } }),
    })

    expect(model.liveOutputTokens).toBe(0)
    expect(model.lastTurnOutputTokens).toBe(300)
  })
})

describe('the session head', () => {
  it('counts a turn for every thing the operator said', () => {
    const events = log([
      { type: 'user-said', text: 'rotate the refresh tokens' },
      { type: 'assistant-said', parts: [] },
      { type: 'user-said', text: 'and cover reuse' },
    ])

    expect(deriveSidebar({ events, turn: IDLE_TURN }).turnCount).toBe(2)
  })

  it('titles the session with the first thing the operator said, on one line', () => {
    const events = log([{ type: 'user-said', text: '  Refresh-token\n  rotation  ' }])

    expect(deriveSidebar({ events, turn: IDLE_TURN }).title).toBe('Refresh-token rotation')
  })

  it('truncates a title that would not fit the sidebar', () => {
    const events = log([{ type: 'user-said', text: 'R'.repeat(200) }])

    const title = deriveSidebar({ events, turn: IDLE_TURN }).title ?? ''

    expect([...title].length).toBeLessThanOrEqual(SIDEBAR_WIDTH)
    expect(title.endsWith('…')).toBe(true)
  })

  it('prefers the name the session was given over the first thing said', () => {
    const events = log([{ type: 'user-said', text: 'the refresh token never rotates' }])

    expect(deriveSidebar({ events, turn: IDLE_TURN, name: 'Refresh-token rotation' }).title).toBe(
      'Refresh-token rotation',
    )
  })

  it('falls back to the opening message while the session is still unnamed', () => {
    const events = log([{ type: 'user-said', text: 'the refresh token never rotates' }])

    expect(deriveSidebar({ events, turn: IDLE_TURN, name: null }).title).toBe(
      'the refresh token never rotates',
    )
  })

  it('ignores a name that is blank rather than showing an empty heading', () => {
    const events = log([{ type: 'user-said', text: 'rotate the tokens' }])

    expect(deriveSidebar({ events, turn: IDLE_TURN, name: '   ' }).title).toBe('rotate the tokens')
  })

  it('truncates a name too long for the sidebar', () => {
    const title = deriveSidebar({ events: [], turn: IDLE_TURN, name: 'R'.repeat(200) }).title ?? ''

    expect([...title].length).toBeLessThanOrEqual(SIDEBAR_WIDTH)
    expect(title.endsWith('…')).toBe(true)
  })

  it('leaves the title unset on an empty thread, and on one that says nothing', () => {
    expect(deriveSidebar({ events: [], turn: IDLE_TURN }).title).toBeNull()

    const blank = log([{ type: 'user-said', text: '   \n  ' }])
    expect(deriveSidebar({ events: blank, turn: IDLE_TURN }).title).toBeNull()
  })

  it('totals the tokens the turn clock has counted, live or settled', () => {
    const live = deriveSidebar({ events: [], turn: turnOf({ startedAt: 1000, outputTokens: 120 }) })
    expect(live.totalTokens).toBe(120)

    const settled = deriveSidebar({
      events: [],
      turn: turnOf({ completed: { durationMs: 4000, outputTokens: 300 } }),
    })
    expect(settled.totalTokens).toBe(300)

    expect(deriveSidebar({ events: [], turn: IDLE_TURN }).totalTokens).toBe(0)
  })
})

describe('the sections no producer feeds yet', () => {
  it('leaves them absent rather than empty, so no bare header is drawn', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      { type: 'tool-called', callId: CALL_ONE, name: 'bash', input: {}, ordinal: 0 },
    ])

    const model = deriveSidebar({ events, turn: turnOf({ startedAt: 1000, outputTokens: 12 }) })

    expect(model.git).toBeUndefined()
    expect(model.pr).toBeUndefined()
    expect(model.ci).toBeUndefined()
    expect(model.todo).toBeUndefined()
    expect(model.subagents).toBeUndefined()
    expect(model.teammates).toBeUndefined()
  })

  it('keeps the idle sidebar a valid model with nothing fed to it', () => {
    expect(IDLE_SIDEBAR.title).toBeNull()
    expect(IDLE_SIDEBAR.turnCount).toBe(0)
    expect(IDLE_SIDEBAR.totalTokens).toBe(0)
    expect(IDLE_SIDEBAR.todo).toBeUndefined()
  })
})
