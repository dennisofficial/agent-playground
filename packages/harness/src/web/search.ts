import {
  BACKEND_TRAITS,
  EWebSearchBackend,
  secretNameOf,
  type SecretsPort,
  type WebSearchFindings,
} from '@dltech/atlas-core'

import type { SearchBackend, SearchOutcome } from './backends/contract'
import { duckDuckGo } from './backends/duckduckgo'
import { jina } from './backends/jina'
import { brave, exa, searxng, tavily } from './backends/keyed'

const BACKENDS: Record<EWebSearchBackend, SearchBackend> = {
  [EWebSearchBackend.DuckDuckGo]: duckDuckGo,
  [EWebSearchBackend.Jina]: jina,
  [EWebSearchBackend.Tavily]: tavily,
  [EWebSearchBackend.Exa]: exa,
  [EWebSearchBackend.Brave]: brave,
  [EWebSearchBackend.SearXNG]: searxng,
}

export const credentialFor = (args: {
  backend: EWebSearchBackend
  secrets: SecretsPort
}): string | undefined => {
  if (BACKEND_TRAITS[args.backend].keyLabel === undefined) return undefined

  const found = args.secrets.read(secretNameOf(args.backend))
  return found === undefined || found.length === 0 ? undefined : found
}

export type FindingsOutcome =
  { ok: true; findings: WebSearchFindings } | { ok: false; reason: string }

export async function runSearch(args: {
  backend: EWebSearchBackend
  query: string
  count: number
  signal: AbortSignal
  secrets: SecretsPort
}): Promise<FindingsOutcome> {
  const outcome: SearchOutcome = await BACKENDS[args.backend]({
    query: args.query,
    count: args.count,
    signal: args.signal,
    credential: credentialFor({ backend: args.backend, secrets: args.secrets }),
  })

  if (!outcome.ok) return outcome
  return {
    ok: true,
    findings: { query: args.query, backend: args.backend, results: outcome.results },
  }
}
