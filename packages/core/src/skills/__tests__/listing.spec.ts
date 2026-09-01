import { describe, expect, it } from 'bun:test'

import {
  renderSkillListing,
  SKILL_LISTING_MAX_DESCRIPTION_CHARS,
  type SkillListingEntry,
} from '../listing'

const entry = (args: Partial<SkillListingEntry> & { name: string }): SkillListingEntry => ({
  description: 'does a thing',
  whenToUse: undefined,
  ...args,
})

describe('renderSkillListing', () => {
  it('returns nothing for no entries', () => {
    expect(renderSkillListing({ entries: [] })).toBe('')
  })

  it('renders one line per skill', () => {
    const rendered = renderSkillListing({
      entries: [entry({ name: 'review' }), entry({ name: 'deploy', description: 'ships it' })],
    })

    expect(rendered).toBe('- review: does a thing\n- deploy: ships it')
  })

  it('appends when to use after the description', () => {
    const rendered = renderSkillListing({
      entries: [entry({ name: 'review', whenToUse: 'after a rebase' })],
    })

    expect(rendered).toBe('- review: does a thing Use when: after a rebase')
  })

  it('renders a bare name when there is nothing to say', () => {
    expect(renderSkillListing({ entries: [entry({ name: 'review', description: '' })] })).toBe(
      '- review',
    )
  })

  it('truncates a long description to the cap', () => {
    const rendered = renderSkillListing({
      entries: [entry({ name: 'review', description: 'd'.repeat(50) })],
      maxDescriptionChars: 10,
    })

    expect(rendered).toBe(`- review: ${'d'.repeat(9)}…`)
  })

  it('caps descriptions by default', () => {
    const rendered = renderSkillListing({
      entries: [
        entry({
          name: 'review',
          description: 'd'.repeat(SKILL_LISTING_MAX_DESCRIPTION_CHARS + 40),
        }),
      ],
    })

    expect(rendered.length).toBe('- review: '.length + SKILL_LISTING_MAX_DESCRIPTION_CHARS)
  })

  it('drops descriptions from the end until the listing fits its budget', () => {
    const entries = [
      entry({ name: 'first', description: 'aaaaaaaaaa' }),
      entry({ name: 'second', description: 'bbbbbbbbbb' }),
      entry({ name: 'third', description: 'cccccccccc' }),
    ]

    expect(renderSkillListing({ entries, budgetChars: 40 })).toBe(
      '- first: aaaaaaaaaa\n- second\n- third',
    )
  })

  it('keeps every name when nothing fits', () => {
    const entries = [entry({ name: 'first' }), entry({ name: 'second' })]

    expect(renderSkillListing({ entries, budgetChars: 1 })).toBe('- first\n- second')
  })

  it('leaves the listing whole when it is inside the budget', () => {
    const entries = [entry({ name: 'first', description: 'a' })]

    expect(renderSkillListing({ entries, budgetChars: 1000 })).toBe('- first: a')
  })
})
