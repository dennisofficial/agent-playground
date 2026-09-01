import type { WebSearchResult } from '@dltech/atlas-core'

import { failedWith, records, str, type SearchBackend } from './contract'

/**
 * Jina reads a key when there is one and serves anonymously when there is not, at a lower rate
 * limit. It is the only backend here that is useful both ways, so a missing key is not a refusal.
 * https://jina.ai/reader
 */
export const jina: SearchBackend = async ({ query, count, signal, credential }) => {
  const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    headers: {
      accept: 'application/json',
      ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    },
    signal,
  })

  if (response.status === 429) {
    return {
      ok: false,
      reason:
        'Jina rate-limited this search. Anonymous use is capped at 20 requests a minute; a free JINA_API_KEY raises it to 500.',
    }
  }
  if (!response.ok)
    return failedWith({ label: 'Jina', status: response.status, body: await response.text() })

  const payload: unknown = await response.json()
  const rows = records((payload as Record<string, unknown>)['data'])

  return {
    ok: true,
    results: rows.slice(0, count).flatMap((row): WebSearchResult[] => {
      const url = str(row['url'])
      if (url === undefined) return []
      return [
        {
          title: str(row['title']) ?? url,
          url,
          snippet: str(row['description']),
          content: str(row['content']),
        },
      ]
    }),
  }
}
