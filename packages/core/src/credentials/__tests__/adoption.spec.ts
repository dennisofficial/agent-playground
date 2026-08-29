import { describe, expect, it } from 'bun:test'

import type { OauthTokens } from '../account'
import { adoptionOf, EAdoption } from '../adoption'

const tokens = (args: {
  access: string
  refresh: string
  expiresAt?: string
}): OauthTokens => ({
  accessToken: args.access,
  refreshToken: args.refresh,
  expiresAt: args.expiresAt ?? '2026-01-01T12:00:00.000Z',
})

const STORED = tokens({ access: 'access-1', refresh: 'refresh-1' })

describe('adoptionOf', () => {
  it('adopts a newer pair', () => {
    const observed = tokens({
      access: 'access-2',
      refresh: 'refresh-2',
      expiresAt: '2026-01-01T13:00:00.000Z',
    })

    expect(adoptionOf({ observed, stored: STORED, others: [] })).toBe(EAdoption.Adopt)
  })

  it('says nothing happened when the pair is the one we wrote', () => {
    expect(adoptionOf({ observed: STORED, stored: STORED, others: [] })).toBe(EAdoption.Unchanged)
  })

  it('refuses a pair that belongs to another account, matched on either half', () => {
    const sibling = tokens({ access: 'access-9', refresh: 'refresh-9' })
    const halfMatch = tokens({
      access: 'access-9',
      refresh: 'refresh-fresh',
      expiresAt: '2026-01-01T14:00:00.000Z',
    })

    expect(adoptionOf({ observed: halfMatch, stored: STORED, others: [sibling] })).toBe(
      EAdoption.Foreign,
    )
  })

  it('refuses to undo a refresh we already made', () => {
    const older = tokens({
      access: 'access-0',
      refresh: 'refresh-0',
      expiresAt: '2026-01-01T11:00:00.000Z',
    })

    expect(adoptionOf({ observed: older, stored: STORED, others: [] })).toBe(EAdoption.Stale)
  })

  it('never overwrites a working credential with blanks', () => {
    const half = tokens({ access: 'access-2', refresh: '' })

    expect(adoptionOf({ observed: half, stored: STORED, others: [] })).toBe(EAdoption.Unusable)
  })
})
