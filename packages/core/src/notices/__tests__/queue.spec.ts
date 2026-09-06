import { describe, expect, it } from 'bun:test'

import { ENoticePosition, ENoticeTone, type Notice, type NoticeDraft } from '../notice'
import { clearNotice, expireNotices, nextExpiryAtMs, postNotice } from '../queue'

const draft = (over: Partial<NoticeDraft> & { key: string }): NoticeDraft => ({
  text: over.key,
  tone: ENoticeTone.Done,
  ttlMs: 1000,
  ...over,
})

const post = (notices: readonly Notice[], over: Partial<NoticeDraft> & { key: string }, at = 0) =>
  postNotice({ notices, draft: draft(over), issuedAtMs: at })

describe('postNotice', () => {
  it('appends a new key after the ones already standing', () => {
    const notices = post(post([], { key: 'a' }), { key: 'b' })

    expect(notices.map((notice) => notice.key)).toEqual(['a', 'b'])
  })

  it('lands a notice in the tray unless its draft names the composer edge', () => {
    const notices = post(post([], { key: 'a' }), { key: 'b', position: ENoticePosition.Composer })

    expect(notices[0]?.position).toBe(ENoticePosition.Tray)
    expect(notices[1]?.position).toBe(ENoticePosition.Composer)
  })

  it('replaces a standing key in place rather than stacking a twin', () => {
    const notices = post(post(post([], { key: 'a' }), { key: 'copy' }), { key: 'copy', text: 'copied 4 lines' })

    expect(notices.map((notice) => notice.key)).toEqual(['a', 'copy'])
    expect(notices[1]?.text).toBe('copied 4 lines')
  })

  it('refreshes the clock on a replace, so a reposted notice lives a full ttl again', () => {
    const first = post([], { key: 'copy' }, 0)
    const second = post(first, { key: 'copy' }, 900)

    expect(second[0]?.issuedAtMs).toBe(900)
    expect(expireNotices({ notices: second, nowMs: 1899 })).toHaveLength(1)
    expect(expireNotices({ notices: second, nowMs: 1900 })).toHaveLength(0)
  })

  it('sheds the oldest expiring notice when the stack is full, keeping the sticky ones standing', () => {
    let notices: readonly Notice[] = []
    notices = post(notices, { key: 'sticky', ttlMs: null })
    notices = post(notices, { key: 'one' })
    notices = post(notices, { key: 'two' })
    notices = post(notices, { key: 'three' })

    expect(notices.map((notice) => notice.key)).toEqual(['sticky', 'two', 'three'])
  })

  it('sheds the oldest sticky when everything standing is sticky and the stack is full', () => {
    let notices: readonly Notice[] = []
    for (const key of ['a', 'b', 'c']) notices = post(notices, { key, ttlMs: null })
    notices = post(notices, { key: 'd', ttlMs: null })

    expect(notices.map((notice) => notice.key)).toEqual(['b', 'c', 'd'])
  })
})

describe('expireNotices', () => {
  it('drops only the notices whose ttl has fully elapsed', () => {
    const notices = post(post([], { key: 'old' }, 0), { key: 'fresh' }, 800)

    expect(expireNotices({ notices, nowMs: 999 })).toHaveLength(2)
    expect(expireNotices({ notices, nowMs: 1000 }).map((notice) => notice.key)).toEqual(['fresh'])
  })

  it('never drops a sticky notice', () => {
    const notices = post([], { key: 'offline', ttlMs: null }, 0)

    expect(expireNotices({ notices, nowMs: Number.MAX_SAFE_INTEGER })).toHaveLength(1)
  })
})

describe('nextExpiryAtMs', () => {
  it('is the soonest deadline among the expiring notices', () => {
    const notices = post(post([], { key: 'a', ttlMs: 5000 }, 0), { key: 'b', ttlMs: 1000 }, 0)

    expect(nextExpiryAtMs({ notices })).toBe(1000)
  })

  it('is null when nothing standing can expire', () => {
    expect(nextExpiryAtMs({ notices: [] })).toBeNull()
    expect(nextExpiryAtMs({ notices: post([], { key: 'a', ttlMs: null }) })).toBeNull()
  })
})

describe('clearNotice', () => {
  it('drops the named key and leaves the rest standing', () => {
    const notices = post(post([], { key: 'a' }), { key: 'b' })

    expect(clearNotice({ notices, key: 'a' }).map((notice) => notice.key)).toEqual(['b'])
    expect(clearNotice({ notices, key: 'unknown' })).toHaveLength(2)
  })
})
