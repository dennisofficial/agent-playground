import type { WebSearchResult } from '@dltech/atlas-core'

import { failedWith, postJson, records, str, type SearchBackend } from './contract'

const missing = (label: string, variable: string): { ok: false; reason: string } => ({
  ok: false,
  reason: `${label} needs a key. Set ${variable} in your environment, or choose another search backend in /settings.`,
})

export const tavily: SearchBackend = async ({ query, count, signal, credential }) => {
  if (credential === undefined) return missing('Tavily', 'TAVILY_API_KEY')

  const response = await postJson({
    url: 'https://api.tavily.com/search',
    headers: { authorization: `Bearer ${credential}` },
    body: { query, max_results: count, include_raw_content: 'markdown' },
    signal,
  })
  if (!response.ok)
    return failedWith({ label: 'Tavily', status: response.status, body: await response.text() })

  const payload: unknown = await response.json()
  const rows = records((payload as Record<string, unknown>)['results'])

  return {
    ok: true,
    results: rows.flatMap((row): WebSearchResult[] => {
      const url = str(row['url'])
      if (url === undefined) return []
      return [
        {
          title: str(row['title']) ?? url,
          url,
          snippet: str(row['content']),
          content: str(row['raw_content']),
        },
      ]
    }),
  }
}

export const exa: SearchBackend = async ({ query, count, signal, credential }) => {
  if (credential === undefined) return missing('Exa', 'EXA_API_KEY')

  const response = await postJson({
    url: 'https://api.exa.ai/search',
    headers: { 'x-api-key': credential },
    body: { query, numResults: count, contents: { text: { maxCharacters: 4000 } } },
    signal,
  })
  if (!response.ok)
    return failedWith({ label: 'Exa', status: response.status, body: await response.text() })

  const payload: unknown = await response.json()
  const rows = records((payload as Record<string, unknown>)['results'])

  return {
    ok: true,
    results: rows.flatMap((row): WebSearchResult[] => {
      const url = str(row['url'])
      if (url === undefined) return []
      return [
        {
          title: str(row['title']) ?? url,
          url,
          content: str(row['text']),
          publishedAt: str(row['publishedDate']),
        },
      ]
    }),
  }
}

export const brave: SearchBackend = async ({ query, count, signal, credential }) => {
  if (credential === undefined) return missing('Brave', 'BRAVE_API_KEY')

  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(count))

  const response = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': credential },
    signal,
  })
  if (!response.ok)
    return failedWith({ label: 'Brave', status: response.status, body: await response.text() })

  const payload: unknown = await response.json()
  const web = (payload as Record<string, unknown>)['web']
  const rows = records(
    typeof web === 'object' && web !== null ? (web as Record<string, unknown>)['results'] : [],
  )

  return {
    ok: true,
    results: rows.flatMap((row): WebSearchResult[] => {
      const url = str(row['url'])
      if (url === undefined) return []
      return [
        {
          title: str(row['title']) ?? url,
          url,
          snippet: str(row['description']),
          publishedAt: str(row['age']),
        },
      ]
    }),
  }
}

export const searxng: SearchBackend = async ({ query, count, signal, credential }) => {
  if (credential === undefined) return missing('SearXNG', 'ATLAS_SEARXNG_URL')

  const url = new URL('/search', credential)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')

  let response: Response
  try {
    response = await fetch(url, { headers: { accept: 'application/json' }, signal })
  } catch (error) {
    return {
      ok: false,
      reason: `could not reach your SearXNG instance: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `your SearXNG instance answered ${response.status}. Public instances usually disable format=json; it has to be enabled in settings.yml.`,
    }
  }

  const payload: unknown = await response.json()
  const rows = records((payload as Record<string, unknown>)['results'])

  return {
    ok: true,
    results: rows.slice(0, count).flatMap((row): WebSearchResult[] => {
      const url = str(row['url'])
      if (url === undefined) return []
      return [
        {
          title: str(row['title']) ?? url,
          url,
          snippet: str(row['content']),
          publishedAt: str(row['publishedDate']),
        },
      ]
    }),
  }
}
