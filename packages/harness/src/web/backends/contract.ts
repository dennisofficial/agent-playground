import type { WebSearchResult } from '@dltech/atlas-core'

export type SearchRequest = {
  query: string
  count: number
  signal: AbortSignal
  credential: string | undefined
}

export type SearchOutcome =
  { ok: true; results: readonly WebSearchResult[] } | { ok: false; reason: string }

export type SearchBackend = (request: SearchRequest) => Promise<SearchOutcome>

export const failedWith = (args: {
  label: string
  status: number
  body: string
}): SearchOutcome => ({
  ok: false,
  reason: `${args.label} answered ${args.status}${args.body.length === 0 ? '' : `: ${args.body.slice(0, 300)}`}`,
})

export async function postJson(args: {
  url: string
  body: unknown
  headers: Record<string, string>
  signal: AbortSignal
}): Promise<Response> {
  return await fetch(args.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...args.headers },
    body: JSON.stringify(args.body),
    signal: args.signal,
  })
}

export const records = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      )
    : []

export const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
