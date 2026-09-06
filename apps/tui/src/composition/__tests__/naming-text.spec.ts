import { EContextSlot, type EventDraft } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { NAMING_ATTACHMENT_CHARACTER_LIMIT, namingTextOf } from '../naming-text'

const fileDraft = (path: string, content: string): EventDraft => ({
  type: 'context-loaded',
  slot: EContextSlot.File,
  key: path,
  content,
})

const skillDraft = (name: string, body: string): EventDraft => ({
  type: 'context-loaded',
  slot: EContextSlot.Skill,
  key: name,
  content: body,
})

describe('namingTextOf', () => {
  it('is the opening message alone when nothing was attached to it', () => {
    expect(namingTextOf({ said: 'the refresh token never rotates' })).toBe(
      'the refresh token never rotates',
    )
  })

  it('hands the titler the head of a file the opening message attached', () => {
    const text = namingTextOf({
      said: 'check out this handoff, and lets plan it',
      context: [
        fileDraft(
          '/tmp/atlas-rewind-subagents-handoff.md',
          '# Handoff: rewind kills sub-agents\n\nWhen a turn is rewound, its sub-agents...',
        ),
      ],
    })

    expect(text).toContain('check out this handoff, and lets plan it')
    expect(text).toContain('/tmp/atlas-rewind-subagents-handoff.md')
    expect(text).toContain('Handoff: rewind kills sub-agents')
  })

  it('excerpts an attached file rather than sending it to be named whole', () => {
    const text = namingTextOf({
      said: 'plan this',
      context: [fileDraft('/tmp/big-handoff.md', 'h'.repeat(9000))],
    })

    expect(text.length).toBeLessThan('plan this'.length + NAMING_ATTACHMENT_CHARACTER_LIMIT + 60)
  })

  it('leaves an invoked skill out, since the message already names it', () => {
    const text = namingTextOf({
      said: 'lets /implement with /tdd',
      context: [skillDraft('tdd', 'write the failing test first, watch it fail, then...')],
    })

    expect(text).toBe('lets /implement with /tdd')
  })

  it('ignores drafts that carry no context', () => {
    const text = namingTextOf({
      said: 'hello',
      context: [{ type: 'user-said', text: 'noise' }],
    })

    expect(text).toBe('hello')
  })
})
