import { describe, expect, it } from 'bun:test'

import { HOOK_CONTEXT_KEY, hookOutcomeDrafts } from '../outcome'

describe('hookOutcomeDrafts', () => {
  it('turns additionalContext into a context-loaded draft slotted under the hook that spoke', () => {
    expect(hookOutcomeDrafts({ hookName: 'gitState', outcome: { additionalContext: '3 files dirty' } })).toEqual([
      { type: 'context-loaded', slot: 'gitState', key: HOOK_CONTEXT_KEY, content: '3 files dirty' },
    ])
  })

  it('gives one hook the same slot and key every time, so its context supersedes rather than piles up', () => {
    const first = hookOutcomeDrafts({ hookName: 'gitState', outcome: { additionalContext: '3 files dirty' } })
    const second = hookOutcomeDrafts({ hookName: 'gitState', outcome: { additionalContext: '1 file dirty' } })

    expect(first[0]).toMatchObject({ slot: 'gitState', key: HOOK_CONTEXT_KEY })
    expect(second[0]).toMatchObject({ slot: 'gitState', key: HOOK_CONTEXT_KEY })
  })

  it('keeps two hooks in separate slots even when they say the same thing', () => {
    const one = hookOutcomeDrafts({ hookName: 'gitState', outcome: { additionalContext: 'same' } })
    const other = hookOutcomeDrafts({ hookName: 'testState', outcome: { additionalContext: 'same' } })

    expect([one[0], other[0]]).toMatchObject([{ slot: 'gitState' }, { slot: 'testState' }])
  })

  it('passes drafts through untouched', () => {
    const outcome = { drafts: [{ type: 'nudge' as const, text: 'keep going', lifetimeSteps: 1 }] }

    expect(hookOutcomeDrafts({ hookName: 'nudger', outcome })).toEqual([
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
    ])
  })

  it('puts the context ahead of the drafts, so a draft may refer to what the model just read', () => {
    const outcome = {
      additionalContext: '3 files dirty',
      drafts: [{ type: 'nudge' as const, text: 'commit first', lifetimeSteps: 1 }],
    }

    expect(hookOutcomeDrafts({ hookName: 'gitState', outcome }).map((draft) => draft.type)).toEqual([
      'context-loaded',
      'nudge',
    ])
  })

  it('returns nothing for a hook that had nothing to say', () => {
    expect(hookOutcomeDrafts({ hookName: 'quiet', outcome: {} })).toEqual([])
  })

  it('drops blank context rather than spending tokens on an empty reminder', () => {
    expect(hookOutcomeDrafts({ hookName: 'quiet', outcome: { additionalContext: '   \n' } })).toEqual([])
  })

  it('leaves the content byte-identical, so the log can dedupe on its digest', () => {
    const content = '  leading and trailing space matters  '
    const [draft] = hookOutcomeDrafts({ hookName: 'gitState', outcome: { additionalContext: content } })

    expect(draft).toMatchObject({ content })
  })
})
