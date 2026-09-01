import { describe, expect, it } from 'bun:test'

import { CACHE_TTL_MS, PageCache } from '../cache'

const page = (url: string) => ({
  url,
  finalUrl: url,
  bytes: 10,
  body: `body of ${url}`,
  truncated: false,
})

describe('PageCache', () => {
  it('hands back what it was given, within the window', () => {
    const cache = new PageCache(() => 0)
    cache.write({ url: 'https://a.test', format: 'markdown', page: page('https://a.test') })

    expect(cache.read({ url: 'https://a.test', format: 'markdown' })?.body).toBe(
      'body of https://a.test',
    )
  })

  it('forgets a page once the window has passed', () => {
    let clock = 0
    const cache = new PageCache(() => clock)
    cache.write({ url: 'https://a.test', format: 'markdown', page: page('https://a.test') })

    clock = CACHE_TTL_MS - 1
    expect(cache.read({ url: 'https://a.test', format: 'markdown' })).toBeDefined()

    clock = CACHE_TTL_MS
    expect(cache.read({ url: 'https://a.test', format: 'markdown' })).toBeUndefined()
  })

  it('keeps the formats apart, since the same url asked two ways is two answers', () => {
    const cache = new PageCache(() => 0)
    cache.write({ url: 'https://a.test', format: 'markdown', page: page('https://a.test') })

    expect(cache.read({ url: 'https://a.test', format: 'text' })).toBeUndefined()
  })

  it('drops the least recently read once it is full rather than growing without bound', () => {
    const cache = new PageCache(() => 0)
    for (let index = 0; index < 40; index += 1) {
      cache.write({
        url: `https://a.test/${index}`,
        format: 'markdown',
        page: page(`https://a.test/${index}`),
      })
    }

    expect(cache.read({ url: 'https://a.test/0', format: 'markdown' })).toBeUndefined()
    expect(cache.read({ url: 'https://a.test/39', format: 'markdown' })).toBeDefined()
  })
})
