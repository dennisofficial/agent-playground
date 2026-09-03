import { describe, expect, it } from 'bun:test'

import { EMessageOrigin, type EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toEventId, toRunId, toThreadId } from '../../events/ids'
import { awaitsReply } from '../../events/projections'
import { stampDrafts } from '../../events/stamp'
import { EShellStatus } from '../../shells/status'
import { messagesFromEvents } from '../../assembly/rules/messages-from-events'
import { tldrAnchor } from '../anchor'
import { tldrDue } from '../due'
import { latestTldrPerAnchor } from '../footers'

const eventsFrom = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

const said = (text: string): EventDraft => ({ type: 'user-said', text })

const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})

const tldr = (args: { anchorSeq: number; throughSeq: number; text: string }): EventDraft => ({
  type: 'tldr-written',
  anchorSeq: args.anchorSeq,
  throughSeq: args.throughSeq,
  text: args.text,
  modelId: 'claude-haiku-4-5-20251001',
})

describe('tldrAnchor', () => {
  it('is the seq of the last operator message', () => {
    const events = eventsFrom([said('first'), replied('one'), said('second'), replied('two')])
    expect(tldrAnchor(events)).toBe(3)
  })

  it('ignores messages from a parent agent', () => {
    const events = eventsFrom([
      said('operator'),
      { type: 'user-said', text: 'steered by parent', via: EMessageOrigin.ParentAgent },
      replied('done'),
    ])
    expect(tldrAnchor(events)).toBe(1)
  })

  it('is undefined on a thread the operator never spoke in', () => {
    const events = eventsFrom([
      { type: 'user-said', text: 'brief', via: EMessageOrigin.ParentAgent },
      replied('working'),
    ])
    expect(tldrAnchor(events)).toBeUndefined()
  })
})

describe('tldrDue', () => {
  it('covers from the anchor to the head', () => {
    const events = eventsFrom([said('fix it'), replied('fixed')])
    expect(tldrDue(events)).toEqual({ anchorSeq: 1, throughSeq: 2 })
  })

  it('is not due when the operator never spoke', () => {
    expect(tldrDue(eventsFrom([replied('talking to myself')]))).toBeUndefined()
  })

  it('is not due when nothing was said above the anchor', () => {
    expect(tldrDue(eventsFrom([said('hello')]))).toBeUndefined()
  })

  it('is not due when the reply above the anchor is empty text', () => {
    const events = eventsFrom([said('hi'), replied('   ')])
    expect(tldrDue(events)).toBeUndefined()
  })

  it('is not due when a footer already covers the head', () => {
    const events = eventsFrom([
      said('fix it'),
      replied('fixed'),
      tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed the thing.' }),
    ])
    expect(tldrDue(events)).toBeUndefined()
  })

  it('is due again when the head moved past the existing footer', () => {
    const events = eventsFrom([
      said('fix it'),
      replied('fixed, build running'),
      tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed; build running.' }),
      { type: 'background-shell-ended', shellId: 'bash_1', command: 'bun run build', status: EShellStatus.Exited, output: 'ok', droppedCharacters: 0, remainingCharacters: 2 },
      replied('build green'),
    ])
    expect(tldrDue(events)).toEqual({ anchorSeq: 1, throughSeq: 5 })
  })
})

describe('latestTldrPerAnchor', () => {
  it('keeps only the newest footer per anchor, ordered by throughSeq', () => {
    const events = eventsFrom([
      said('one'),
      replied('a'),
      tldr({ anchorSeq: 1, throughSeq: 2, text: 'early' }),
      replied('b'),
      tldr({ anchorSeq: 1, throughSeq: 4, text: 'late' }),
      said('two'),
      replied('c'),
      tldr({ anchorSeq: 6, throughSeq: 7, text: 'second turn' }),
    ])

    const footers = latestTldrPerAnchor(events)
    expect(footers.map((footer) => footer.text)).toEqual(['late', 'second turn'])
  })
})

describe('tldr-written in the loop and the prompt', () => {
  it('is not turn-taking: a trailing footer never flips awaitsReply', () => {
    const events = eventsFrom([
      said('fix it'),
      replied('fixed'),
      tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed the thing.' }),
    ])
    expect(awaitsReply(events)).toBe(false)
  })

  it('renders into the assembled prompt as nothing', () => {
    const events = eventsFrom([
      said('fix it'),
      replied('fixed'),
      tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed the thing.' }),
    ])
    const { assembled } = {
      assembled: messagesFromEvents()(
        { system: [], messages: [] },
        {
          events,
          threadId: toThreadId('thread-1'),
          step: 0,
          provider: { id: 'anthropic', modelId: 'test' },
          countTokens: () => 0,
        },
      ),
    }

    const rendered = JSON.stringify(assembled.messages)
    expect(rendered).not.toContain('Fixed the thing.')
    expect(rendered).not.toContain('tldr')
  })
})
