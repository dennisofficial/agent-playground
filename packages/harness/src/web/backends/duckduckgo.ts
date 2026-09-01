import type { WebSearchResult } from '@dltech/atlas-core'
import { Parser } from 'htmlparser2'

import type { SearchBackend } from './contract'

const ENDPOINT = 'https://html.duckduckgo.com/html/'

const AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * DuckDuckGo wraps every outbound link in a redirect whose real target is the `uddg` parameter, so
 * the href as written is never the result's own url.
 */
export function unwrapTarget(href: string): string | undefined {
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(absolute, 'https://duckduckgo.com')
    const wrapped = parsed.searchParams.get('uddg')
    if (wrapped !== null) return wrapped
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.toString()
      : undefined
  } catch {
    return undefined
  }
}

const classes = (attributes: Record<string, string>): string => attributes['class'] ?? ''

export function parseResults(html: string): readonly WebSearchResult[] {
  const found: WebSearchResult[] = []
  let pending: { title: string; url: string } | undefined
  let capturing: 'title' | 'snippet' | undefined
  let depth = 0
  let buffer = ''

  const finish = (): void => {
    const collected = buffer.replaceAll(/\s+/g, ' ').trim()

    if (capturing === 'title' && pending !== undefined) {
      pending = { ...pending, title: collected }
    } else if (capturing === 'snippet' && pending !== undefined) {
      found.push({
        title: pending.title,
        url: pending.url,
        ...(collected.length === 0 ? {} : { snippet: collected }),
      })
      pending = undefined
    }

    capturing = undefined
    buffer = ''
  }

  const parser = new Parser(
    {
      // The query terms inside a result are wrapped in their own tags, so a capture that ended at the
      // first close tag would keep only the words before the first bolded one.
      onopentag(name, attributes) {
        if (capturing !== undefined) {
          depth += 1
          return
        }

        const named = classes(attributes)
        if (name === 'a' && named.includes('result__a')) {
          const target = unwrapTarget(attributes['href'] ?? '')
          if (target === undefined) return
          pending = { title: '', url: target }
          capturing = 'title'
          depth = 0
          buffer = ''
          return
        }
        if (named.includes('result__snippet') && pending !== undefined) {
          capturing = 'snippet'
          depth = 0
          buffer = ''
        }
      },
      ontext(text) {
        if (capturing !== undefined) buffer += text
      },
      onclosetag() {
        if (capturing === undefined) return
        if (depth > 0) {
          depth -= 1
          return
        }
        finish()
      },
    },
    { decodeEntities: true },
  )

  parser.write(html)
  parser.end()

  return found.filter((result) => result.title.length > 0)
}

// DuckDuckGo signals a throttled unauthenticated search with 202 rather than 429, so an ordinary
// `response.ok` check reads it as a success and parses an empty page.
const THROTTLED = new Set([202, 429])

const BACKOFF_MS = [600, 1800]

async function waitFor(args: { ms: number; signal: AbortSignal }): Promise<boolean> {
  if (args.signal.aborted) return false

  return await new Promise<boolean>((resolve) => {
    const stop = (): void => {
      clearTimeout(timer)
      resolve(false)
    }

    const timer = setTimeout(() => {
      args.signal.removeEventListener('abort', stop)
      resolve(true)
    }, args.ms)

    args.signal.addEventListener('abort', stop, { once: true })
  })
}

const ask = async (args: { query: string; signal: AbortSignal }): Promise<Response> =>
  await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': AGENT,
      accept: 'text/html',
    },
    body: new URLSearchParams({ q: args.query }).toString(),
    signal: args.signal,
  })

export const duckDuckGo: SearchBackend = async ({ query, count, signal }) => {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response
    try {
      response = await ask({ query, signal })
    } catch (error) {
      if (signal.aborted) {
        return { ok: false, reason: 'the developer interrupted the turn while searching' }
      }
      return {
        ok: false,
        reason: `could not reach DuckDuckGo: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    if (THROTTLED.has(response.status)) {
      const pause = BACKOFF_MS[attempt]
      if (pause !== undefined && (await waitFor({ ms: pause, signal }))) continue

      return {
        ok: false,
        reason:
          'DuckDuckGo rate-limited this search and was still throttling it on retry. It throttles unauthenticated searches, so wait a moment, or pick a search backend with a key in the settings.',
      }
    }

    if (!response.ok) return { ok: false, reason: `DuckDuckGo answered ${response.status}` }

    return { ok: true, results: parseResults(await response.text()).slice(0, count) }
  }
}
