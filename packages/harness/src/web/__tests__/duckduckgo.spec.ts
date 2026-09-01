import { describe, expect, it } from 'bun:test'

import { parseResults, unwrapTarget } from '../backends/duckduckgo'

const result = (args: { href: string; title: string; snippet: string }): string => `
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="${args.href}">${args.title}</a>
    </h2>
    <div class="result__extras">
      <span class="result__icon"><a href="${args.href}"><img class="result__icon__img" width="16" src="//x.test/i.ico" /></a></span>
      <a class="result__url" href="${args.href}">shown.example</a>
    </div>
    <a class="result__snippet" href="${args.href}">${args.snippet}</a>
  </div>`

describe('unwrapTarget', () => {
  it('reads the real target out of a redirect wrapper', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.com%2Fdocs&rut=abc'
    expect(unwrapTarget(wrapped)).toBe('https://bun.com/docs')
  })

  it('passes a plain url through', () => {
    expect(unwrapTarget('https://bun.com/docs')).toBe('https://bun.com/docs')
  })

  it('refuses a target that is not the web', () => {
    expect(unwrapTarget('javascript:alert(1)')).toBeUndefined()
  })
})

describe('parseResults', () => {
  it('keeps a snippet whole when the query terms inside it are marked up', () => {
    const html = result({
      href: 'https://bun.com/docs/runtime/glob',
      title: 'Glob | Bun Docs',
      snippet:
        '<b>Bun</b> includes a fast native <b>Glob</b> implementation for matching file paths.',
    })

    const [found] = parseResults(html)
    expect(found?.title).toBe('Glob | Bun Docs')
    expect(found?.url).toBe('https://bun.com/docs/runtime/glob')
    expect(found?.snippet).toBe(
      'Bun includes a fast native Glob implementation for matching file paths.',
    )
  })

  it('is not confused by the icon and url anchors between a title and its snippet', () => {
    const html = [
      result({ href: 'https://a.test/one', title: 'One', snippet: 'first <b>thing</b> here' }),
      result({ href: 'https://b.test/two', title: 'Two', snippet: 'second <b>thing</b> here' }),
    ].join('\n')

    const found = parseResults(html)
    expect(found.map((entry) => entry.url)).toEqual(['https://a.test/one', 'https://b.test/two'])
    expect(found.map((entry) => entry.snippet)).toEqual(['first thing here', 'second thing here'])
  })

  it('decodes entities rather than handing the model escapes', () => {
    const html = result({
      href: 'https://a.test',
      title: 'Bun&#x27;s docs',
      snippet: 'uses &quot;glob&quot; &amp; more',
    })

    const [found] = parseResults(html)
    expect(found?.title).toBe("Bun's docs")
    expect(found?.snippet).toBe('uses "glob" & more')
  })

  it('finds nothing in a page with no results rather than throwing', () => {
    expect(parseResults('<html><body><p>no results</p></body></html>')).toEqual([])
  })
})
