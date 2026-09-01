import { describe, expect, it } from 'bun:test'

import { acceptUrl, EUrlRefusal, isPrivateHost, sameHost } from '../url'

describe('acceptUrl', () => {
  it('upgrades http to https', () => {
    const verdict = acceptUrl('http://example.com/docs')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.url).toBe('https://example.com/docs')
  })

  it('refuses a scheme that is not the web', () => {
    for (const candidate of ['file:///etc/passwd', 'ftp://example.com', 'data:text/html,hi']) {
      const verdict = acceptUrl(candidate)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.refusal).toBe(EUrlRefusal.UnsupportedScheme)
    }
  })

  it('refuses the developer own network before a socket opens', () => {
    const refused = [
      'http://localhost:3000',
      'http://127.0.0.1/admin',
      'http://192.168.1.1',
      'http://10.0.0.5',
      'http://172.16.4.2',
      'http://169.254.169.254/latest/meta-data',
      'http://something.internal',
      'http://[::1]/',
    ]

    for (const candidate of refused) {
      const verdict = acceptUrl(candidate)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.refusal).toBe(EUrlRefusal.PrivateHost)
    }
  })

  it('accepts an ordinary public url', () => {
    const verdict = acceptUrl('https://bun.sh/docs/api/fetch')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.host).toBe('bun.sh')
  })

  it('refuses a url longer than the cap', () => {
    const verdict = acceptUrl(`https://example.com/${'a'.repeat(4000)}`)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal).toBe(EUrlRefusal.TooLong)
  })

  it('refuses what is not a url at all', () => {
    const verdict = acceptUrl('not a url')
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal).toBe(EUrlRefusal.Malformed)
  })
})

describe('isPrivateHost', () => {
  it('leaves a public host alone', () => {
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('172.15.0.1')).toBe(false)
    expect(isPrivateHost('11.0.0.1')).toBe(false)
  })
})

describe('sameHost', () => {
  it('compares hostnames rather than urls', () => {
    expect(sameHost('https://a.com/one', 'https://a.com/two')).toBe(true)
    expect(sameHost('https://a.com', 'https://b.com')).toBe(false)
  })
})
