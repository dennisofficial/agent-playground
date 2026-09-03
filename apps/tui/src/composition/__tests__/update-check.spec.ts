import { describe, expect, it } from 'bun:test'

import { latestRelease, releaseNotice, RELEASE_TAG_PREFIX } from '../update-check'

describe('latestRelease', () => {
  it('picks the newest tag in the tui series and ignores the other apps', () => {
    const latest = latestRelease({
      tags: ['tui-v0.1.0', 'api-v9.9.9', 'tui-v0.3.2', 'tui-v0.3.10'],
      prefix: RELEASE_TAG_PREFIX,
    })

    expect(latest?.tag).toBe('tui-v0.3.10')
  })

  it('is null when nothing in the series has shipped', () => {
    expect(latestRelease({ tags: ['api-v1.0.0'], prefix: RELEASE_TAG_PREFIX })).toBeNull()
    expect(latestRelease({ tags: [], prefix: RELEASE_TAG_PREFIX })).toBeNull()
  })

  it('skips tags that carry no readable version', () => {
    const latest = latestRelease({ tags: ['tui-vnext', 'tui-v0.2.0'], prefix: RELEASE_TAG_PREFIX })

    expect(latest?.tag).toBe('tui-v0.2.0')
  })
})

describe('releaseNotice', () => {
  const latest = { tag: 'tui-v0.3.0', version: { major: 0, minor: 3, patch: 0, prerelease: null } }

  it('announces a release ahead of the one running', () => {
    expect(releaseNotice({ current: '0.2.0', latest })).toBe(
      'atlas update: v0.3.0 available (running v0.2.0)',
    )
  })

  it('stays quiet when the running build is the release or ahead of it', () => {
    expect(releaseNotice({ current: '0.3.0', latest })).toBeNull()
    expect(releaseNotice({ current: '0.3.1', latest })).toBeNull()
  })

  it('stays quiet rather than guess when the running version will not parse', () => {
    expect(releaseNotice({ current: 'dev', latest })).toBeNull()
  })
})
