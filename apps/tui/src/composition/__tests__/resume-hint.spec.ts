import { describe, expect, it } from 'bun:test'

import { resumeHint } from '../resume-hint'

describe('what the terminal is left holding after a session', () => {
  it('names the conversation by its title, because that is what an operator recognises', () => {
    const hint = resumeHint({
      threadId: 'brn_cdc39e19-2a64-4f7c-b880-7dc28e766c69',
      title: 'Atlas Daily Driver Setup',
      started: true,
    })

    expect(hint).toContain('atlas --resume "atlas-daily-driver-setup"')
  })

  it('falls back to the id while the conversation is still unnamed', () => {
    const hint = resumeHint({ threadId: 'brn_1', title: null, started: true })

    expect(hint).toContain('atlas --resume "brn_1"')
  })

  it('falls back to the id when a title slugs down to nothing', () => {
    const hint = resumeHint({ threadId: 'brn_1', title: '???', started: true })

    expect(hint).toContain('atlas --resume "brn_1"')
  })

  it('says nothing about a conversation that was never spoken to', () => {
    expect(resumeHint({ threadId: 'brn_1', title: null, started: false })).toBeNull()
  })

  it('says nothing when the app never opened one', () => {
    expect(resumeHint(null)).toBeNull()
  })
})
