import { describe, expect, it } from 'bun:test'

import { resumeHint } from '../resume-hint'

describe('what the terminal is left holding after a session', () => {
  it('names the conversation by its title, because that is what an operator recognises', () => {
    const hint = resumeHint({
      active: {
        threadId: 'brn_cdc39e19-2a64-4f7c-b880-7dc28e766c69',
        title: 'Atlas Daily Driver Setup',
        started: true,
      },
      command: 'atlas',
    })

    expect(hint).toContain('atlas --resume "atlas-daily-driver-setup"')
  })

  it('falls back to the id while the conversation is still unnamed', () => {
    const hint = resumeHint({
      active: { threadId: 'brn_1', title: null, started: true },
      command: 'atlas',
    })

    expect(hint).toContain('atlas --resume "brn_1"')
  })

  it('falls back to the id when a title slugs down to nothing', () => {
    const hint = resumeHint({
      active: { threadId: 'brn_1', title: '???', started: true },
      command: 'atlas',
    })

    expect(hint).toContain('atlas --resume "brn_1"')
  })

  it('offers back the command the session was launched with, so a source run resumes as itself', () => {
    const hint = resumeHint({
      active: { threadId: 'brn_1', title: null, started: true },
      command: 'atlas-dev',
    })

    expect(hint).toContain('atlas-dev --resume "brn_1"')
  })

  it('says nothing about a conversation that was never spoken to', () => {
    expect(
      resumeHint({ active: { threadId: 'brn_1', title: null, started: false }, command: 'atlas' }),
    ).toBeNull()
  })

  it('says nothing when the app never opened one', () => {
    expect(resumeHint({ active: null, command: 'atlas' })).toBeNull()
  })
})
