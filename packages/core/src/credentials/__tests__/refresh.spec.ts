import { describe, expect, it } from 'bun:test'

import { EAuthKind, type AccountSecret } from '../account'
import { DEFAULT_REFRESH_SKEW_MS, ERefresh, isExpired, refreshDecision } from '../refresh'

const NOW = '2026-01-01T12:00:00.000Z'

const minutesFromNow = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString()

const oauth = (args: { expiresAt: string; refreshToken?: string }): AccountSecret => ({
  kind: EAuthKind.Oauth,
  tokens: {
    accessToken: 'access',
    refreshToken: args.refreshToken ?? 'refresh',
    expiresAt: args.expiresAt,
  },
})

describe('refreshDecision', () => {
  it('leaves a token with more than the skew left alone', () => {
    const secret = oauth({ expiresAt: minutesFromNow(30) })

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Fresh)
  })

  it('refreshes inside the skew window, before anything has actually expired', () => {
    const secret = oauth({ expiresAt: minutesFromNow(4) })

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Due)
  })

  it('honours a skew the caller chose', () => {
    const secret = oauth({ expiresAt: minutesFromNow(4) })

    expect(refreshDecision({ secret, now: NOW, skewMs: 60_000 })).toBe(ERefresh.Fresh)
    expect(DEFAULT_REFRESH_SKEW_MS).toBe(5 * 60 * 1000)
  })

  it('refreshes an expired token rather than giving up on it', () => {
    const secret = oauth({ expiresAt: minutesFromNow(-90) })

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Due)
  })

  it('gives up on an expired token with nothing to refresh it with', () => {
    const secret = oauth({ expiresAt: minutesFromNow(-90), refreshToken: '' })

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Unrefreshable)
  })

  it('treats an unreadable expiry as due rather than trusting it', () => {
    const secret = oauth({ expiresAt: 'whenever' })

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Due)
  })

  it('never refreshes an api key', () => {
    const secret: AccountSecret = { kind: EAuthKind.ApiKey, apiKey: 'sk-test' }

    expect(refreshDecision({ secret, now: NOW })).toBe(ERefresh.Fresh)
    expect(isExpired({ secret, now: NOW })).toBe(false)
  })
})

describe('isExpired', () => {
  it('separates a token inside the skew window from one that is actually dead', () => {
    expect(isExpired({ secret: oauth({ expiresAt: minutesFromNow(4) }), now: NOW })).toBe(false)
    expect(isExpired({ secret: oauth({ expiresAt: minutesFromNow(-1) }), now: NOW })).toBe(true)
  })
})
